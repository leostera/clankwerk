import { Id, createStepRegistry, serializeExecutionError, } from "../core/index.js";
import { DurableTaskScheduler } from "./durable.js";
import { createWorkflowManifest } from "./manifest.js";
import { materializeWorkflowRun } from "./materialize.js";
/** Scheduler facade that executes persisted workflow step instances. */
export const createDurableScheduler = async (options) => {
    const deploymentId = crypto.randomUUID();
    await options.database.registerDeployment?.({
        id: deploymentId,
        runtime: options.runtime ?? "local",
        source: options.source ?? { deployedAt: Date.now() },
        startedAt: Date.now(),
    });
    const manifests = new Map();
    for (const workflow of options.workflows) {
        const manifest = await createWorkflowManifest({
            workflowId: Id.workflow(Id.name(workflow.id)),
            tasks: workflow.definitions,
            triggers: workflow.triggers,
        });
        manifests.set(workflow.id, manifest);
        await options.database.register(manifest);
        await options.database.activateWorkflow?.(manifest.workflowId, manifest.definitionHash, deploymentId);
    }
    const triggers = uniqueTriggers(options.workflows.flatMap((workflow) => workflow.triggers));
    return {
        workflows: options.workflows,
        triggers,
        async submitTrigger(triggerId, value) {
            const matching = options.workflows.filter((workflow) => workflow.triggers.some((trigger) => trigger.id === triggerId));
            return Promise.all(matching.map(async (workflow) => {
                const runId = Id.run();
                const now = Date.now();
                const manifest = manifests.get(workflow.id);
                const run = {
                    id: runId,
                    workflowDefinitionHash: manifest.definitionHash,
                    status: "running",
                    input: value,
                    createdAt: now,
                    updatedAt: now,
                };
                await options.database.createRun(run);
                await options.database.appendEvent?.({
                    eventId: Id.event(),
                    type: "trigger.received",
                    runId,
                    triggerId,
                    payload: value,
                });
                await options.database.appendEvent?.({
                    eventId: Id.event(),
                    type: "workflow.scheduled",
                    runId,
                    workflowId: workflow.id,
                });
                await materializeWorkflowRun({ database: options.database, run, manifest, input: value });
                void drainSubmittedRun({
                    workflow: workflow,
                    run,
                    triggerId,
                    value,
                    database: options.database,
                    observer: options.observer,
                });
                return { id: runId, workflowId: workflow.id, triggerId, status: "running" };
            }));
        },
        async runTrigger(triggerId, value) {
            const matching = options.workflows.filter((workflow) => workflow.triggers.some((trigger) => trigger.id === triggerId));
            return Promise.all(matching.map(async (workflow) => {
                const runId = Id.run();
                const now = Date.now();
                const manifest = manifests.get(workflow.id);
                const run = {
                    id: runId,
                    workflowDefinitionHash: manifest.definitionHash,
                    status: "running",
                    input: value,
                    createdAt: now,
                    updatedAt: now,
                };
                await options.database.createRun(run);
                await options.database.appendEvent?.({
                    eventId: Id.event(),
                    type: "trigger.received",
                    runId,
                    triggerId,
                    payload: value,
                });
                await options.database.appendEvent?.({
                    eventId: Id.event(),
                    type: "workflow.scheduled",
                    runId,
                    workflowId: workflow.id,
                });
                try {
                    await materializeWorkflowRun({ database: options.database, run, manifest, input: value });
                    const executor = new DurableTaskScheduler({
                        database: options.database,
                        tasks: createStepRegistry([workflow]),
                        observer: options.observer,
                        triggerValues: new Map([[triggerId, value]]),
                    });
                    let work = 0;
                    do {
                        work = await executor.tick();
                    } while (work > 0);
                    const nodes = (await options.database.getNodes?.(runId)) ?? [];
                    const failed = nodes.find((node) => node.status === "failed");
                    const incomplete = nodes.some((node) => node.status !== "completed");
                    if (failed)
                        throw failed.error ?? new Error(`Step ${failed.nodeId} failed`);
                    if (incomplete)
                        throw new Error(`Run ${runId} has incomplete step instances`);
                    const output = nodes.at(-1)?.output;
                    await options.database.updateRun?.(runId, { status: "completed", updatedAt: Date.now() });
                    await options.database.appendEvent?.({
                        eventId: Id.event(),
                        type: "workflow.completed",
                        runId,
                        status: "completed",
                    });
                    return { id: runId, workflowId: workflow.id, triggerId, status: "completed", output };
                }
                catch (error) {
                    const serialized = serializeExecutionError(error);
                    await options.database.updateRun?.(runId, { status: "failed", updatedAt: Date.now() });
                    await options.database.appendEvent?.({
                        eventId: Id.event(),
                        type: "workflow.completed",
                        runId,
                        status: "failed",
                    });
                    return { id: runId, workflowId: workflow.id, triggerId, status: "failed", error: serialized };
                }
            }));
        },
        run() {
            throw new Error("No HTTP/runtime adapter configured. Use createTriggerApp or call runTrigger().");
        },
    };
};
async function drainSubmittedRun(options) {
    try {
        const executor = new DurableTaskScheduler({
            database: options.database,
            tasks: createStepRegistry([options.workflow]),
            observer: options.observer,
            triggerValues: new Map([[options.triggerId, options.value]]),
        });
        let work = 0;
        do
            work = await executor.tick();
        while (work > 0);
        const nodes = (await options.database.getNodes?.(options.run.id)) ?? [];
        const failed = nodes.find((node) => node.status === "failed");
        const incomplete = nodes.some((node) => node.status !== "completed");
        if (failed)
            throw failed.error ?? new Error(`Step ${failed.nodeId} failed`);
        if (incomplete)
            throw new Error(`Run ${options.run.id} has incomplete step instances`);
        await options.database.updateRun?.(options.run.id, { status: "completed", updatedAt: Date.now() });
        await options.database.appendEvent?.({
            eventId: Id.event(),
            type: "workflow.completed",
            runId: options.run.id,
            status: "completed",
        });
    }
    catch {
        await options.database.updateRun?.(options.run.id, { status: "failed", updatedAt: Date.now() });
        await options.database.appendEvent?.({
            eventId: Id.event(),
            type: "workflow.completed",
            runId: options.run.id,
            status: "failed",
        });
    }
}
function uniqueTriggers(triggers) {
    return [...new Map(triggers.map((trigger) => [trigger.id, trigger])).values()];
}