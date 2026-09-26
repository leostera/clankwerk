import { Effect, Schema } from "effect";
import { Id, PermanentExecutionError, retryabilityOf, serializeExecutionError, } from "../core/index.js";
import { materializeDynamicSteps } from "./dynamic.js";
import { createExecutionKey } from "./execution-key.js";
/** Durable local/DO-compatible execution loop. The database, not the call stack, is authoritative. */
export class DurableTaskScheduler {
    options;
    constructor(options) {
        this.options = options;
    }
    async recover(now = Date.now()) {
        await this.options.database.recoverExpired?.(now);
    }
    async tick(now = Date.now()) {
        const nodes = await this.options.database.ready(now);
        let completed = 0;
        for (const candidate of nodes) {
            const node = await this.options.database.claimNode?.(candidate.id, this.options.leaseMs ?? 60_000);
            if (!node)
                continue;
            await this.options.database.appendEvent?.({
                eventId: Id.event(),
                type: "node.started",
                runId: node.runId,
                nodeId: node.nodeId,
                attempt: node.attempt,
            });
            await this.execute(node);
            completed++;
        }
        return completed;
    }
    async execute(initialNode) {
        let node = initialNode;
        const task = this.options.tasks.get(node.nodeId);
        if (!task) {
            await this.options.database.putNode({
                ...node,
                status: "failed",
                error: serializeExecutionError(new Error(`Task ${node.nodeId} is not registered in this deployment`)),
            });
            return;
        }
        if (task.definition.kind === "fanout" && task.definition.fanoutTemplate) {
            const allNodes = (await this.options.database.getNodes?.(node.runId)) ?? [];
            const prefix = `${node.runId}:${node.nodeId}:`;
            const children = allNodes.filter((candidate) => candidate.id.startsWith(prefix));
            if (children.length === 0) {
                if (!Array.isArray(node.input))
                    throw new Error(`Fan-out step ${node.nodeId} requires an array input`);
                const template = task.definitions.find((definition) => definition.stepId === task.definition.fanoutTemplate);
                if (!template)
                    throw new Error(`Fan-out template ${task.definition.fanoutTemplate} is not registered`);
                await materializeDynamicSteps({
                    database: this.options.database,
                    run: { id: node.runId },
                    template,
                    items: node.input,
                });
                await this.options.database.putNode({ ...node, status: "retry_wait", nextAttemptAt: Date.now() });
                return;
            }
            if (children.some((child) => child.status !== "completed")) {
                await this.options.database.putNode({ ...node, status: "retry_wait", nextAttemptAt: Date.now() });
                return;
            }
            const output = children.map((child) => child.output);
            const { leaseExpiresAt: _lease, error: _error, nextAttemptAt: _next, ...completed } = node;
            await this.options.database.putNode({ ...completed, status: "completed", output });
            await this.options.database.promoteReady?.(node.runId);
            return;
        }
        try {
            let input;
            try {
                input = task.inputSchema ? await Schema.decodeUnknownPromise(task.inputSchema)(node.input) : node.input;
            }
            catch (error) {
                throw new PermanentExecutionError(`Task ${node.nodeId} rejected its persisted input`, { cause: error });
            }
            if (task.definition.cache === "by-input" && node.executionKey === undefined) {
                const run = await this.options.database.getRun(node.runId);
                if (!run)
                    throw new PermanentExecutionError(`Run ${node.runId} is not registered`);
                node = {
                    ...node,
                    executionKey: await createExecutionKey({
                        workflowDefinitionHash: run.workflowDefinitionHash,
                        task: task.definition,
                        input,
                        inputArtifacts: node.inputArtifacts.map((artifact) => artifact.digest),
                        executor: task.definition.executor,
                    }),
                };
                await this.options.database.putNode(node);
            }
            if (node.executionKey) {
                const cached = await this.options.database.cached?.(node.executionKey);
                if (cached && cached.id !== node.id) {
                    const { leaseExpiresAt: _lease, ...reused } = node;
                    await this.options.database.appendEvent?.({
                        eventId: Id.event(),
                        type: "node.cache_hit",
                        runId: node.runId,
                        nodeId: node.nodeId,
                        executionKey: node.executionKey,
                    });
                    await this.options.database.putNode({
                        ...reused,
                        status: "completed",
                        ...(cached.output === undefined ? {} : { output: cached.output }),
                        ...(cached.outputArtifacts === undefined ? {} : { outputArtifacts: cached.outputArtifacts }),
                    });
                    await this.options.database.appendEvent?.({
                        eventId: Id.event(),
                        type: "node.completed",
                        runId: node.runId,
                        nodeId: node.nodeId,
                        output: cached.output,
                        durationMs: 0,
                    });
                    await this.options.database.promoteReady?.(node.runId);
                    return;
                }
            }
            const output = await Effect.runPromise(task.execute(input, {
                runId: node.runId,
                nodeInstanceId: node.id,
                nodeId: node.nodeId,
                attempt: node.attempt,
                triggerValues: this.options.triggerValues ?? new Map(),
                ...(this.options.observer === undefined ? {} : { observer: this.options.observer }),
            }));
            let validatedOutput;
            try {
                validatedOutput = task.outputSchema ? await Schema.decodeUnknownPromise(task.outputSchema)(output) : output;
            }
            catch (error) {
                throw new PermanentExecutionError(`Task ${node.nodeId} produced an invalid output`, { cause: error });
            }
            const { leaseExpiresAt: _lease, error: _error, nextAttemptAt: _next, ...completed } = node;
            await this.options.database.putNode({ ...completed, status: "completed", output: validatedOutput });
            await this.options.database.appendEvent?.({
                eventId: Id.event(),
                type: "node.completed",
                runId: node.runId,
                nodeId: node.nodeId,
                output,
                durationMs: 0,
            });
            await this.options.database.promoteReady?.(node.runId);
        }
        catch (error) {
            const retry = retryPolicy(task.definition.retry, this.options.retry);
            const next = retryabilityOf(error) !== "permanent" && node.attempt < retry.maxAttempts;
            const { leaseExpiresAt: _lease, output: _output, outputArtifacts: _outputArtifacts, ...failed } = node;
            await this.options.database.putNode({
                ...failed,
                status: next ? "retry_wait" : "failed",
                ...(next ? { nextAttemptAt: Date.now() + retry.backoffMs(node.attempt) } : {}),
                error: serializeExecutionError(error),
            });
            await this.options.database.appendEvent?.({
                eventId: Id.event(),
                type: "node.failed",
                runId: node.runId,
                nodeId: node.nodeId,
                attempt: node.attempt,
                error: serializeExecutionError(error),
            });
        }
    }
}
function retryPolicy(task, cap) {
    if (!cap)
        return { maxAttempts: task.maxAttempts, backoffMs: () => task.backoffMs };
    return {
        maxAttempts: Math.min(task.maxAttempts, cap.maxAttempts),
        backoffMs: (attempt) => Math.min(task.backoffMs, cap.backoffMs(attempt)),
    };
}