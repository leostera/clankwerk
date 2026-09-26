import { Cause, Effect } from "effect";
import { findNodeExecutionError, NodeExecutionError } from "./errors.js";
import { Id } from "./id.js";
import { notify } from "./observer.js";
export class Node {
    id;
    triggers;
    observable;
    definition;
    /** A function property intentionally makes Input contravariant and Output covariant. */
    execute;
    definitions;
    implementations;
    inputSchema;
    outputSchema;
    constructor(id, run, triggers = [], observable = true, definition = {
        id,
        stepId: id,
        description: Id.name(id),
        version: "1",
        cache: "never",
        dependencies: [],
        retry: { maxAttempts: 1, backoffMs: 1000 },
    }, definitions = [], implementations = [], inputSchema, outputSchema) {
        this.id = id;
        this.triggers = triggers;
        this.observable = observable;
        this.definition = definition;
        this.inputSchema = inputSchema;
        this.outputSchema = outputSchema;
        this.definitions = [definition, ...definitions];
        this.implementations =
            implementations.length > 0
                ? implementations
                : [{ stepId: definition.stepId, node: this }];
        this.execute = (input, context) => {
            const observer = context?.observer;
            const execution = Effect.catchCause(run(input, context), (cause) => {
                const error = Cause.squash(cause);
                return Effect.fail(findNodeExecutionError(error) ?? new NodeExecutionError(this.id, error));
            });
            if (!observer || !this.observable)
                return execution;
            const startedAt = Date.now();
            return Effect.tapError(Effect.tap(Effect.andThen(Effect.sync(() => notify(() => observer.nodeStarted({
                nodeId: this.id,
                ...(context?.runId === undefined ? {} : { runId: context.runId }),
            }))), execution), (output) => Effect.sync(() => notify(() => observer.nodeCompleted({
                nodeId: this.id,
                output,
                durationMs: Date.now() - startedAt,
                ...(context?.runId === undefined ? {} : { runId: context.runId }),
            })))), (error) => Effect.sync(() => notify(() => observer.nodeFailed({
                nodeId: this.id,
                error,
                durationMs: Date.now() - startedAt,
                ...(context?.runId === undefined ? {} : { runId: context.runId }),
            }))));
        };
    }
    then(next) {
        const nodeId = Id.node();
        return new Node(nodeId, (input, context) => Effect.flatMap(this.execute(input, context), (output) => next instanceof Node ? next.execute(output, context) : toEffect(next(output))), this.triggers, false, {
            ...this.definition,
            id: nodeId,
            stepId: nodeId,
            dependencies: [this.id, ...(next instanceof Node ? [next.id] : [])],
            kind: "composition",
            composition: "then",
        }, [...this.definitions, ...(next instanceof Node ? next.definitions : [])], [...this.implementations, ...(next instanceof Node ? next.implementations : [])]);
    }
    tap(effect) {
        const nodeId = Id.node();
        return new Node(nodeId, (input, context) => Effect.flatMap(this.execute(input, context), (output) => Effect.as(effect.execute(output, context), output)), this.triggers, false, {
            ...this.definition,
            id: nodeId,
            stepId: nodeId,
            dependencies: [this.id, effect.id],
            kind: "composition",
            composition: "tap",
        }, [...this.definitions, ...effect.definitions], [...this.implementations, ...effect.implementations]);
    }
    map(transform) {
        const nodeId = Id.node();
        return new Node(nodeId, (input, context) => Effect.map(this.execute(input, context), transform), this.triggers, false, {
            ...this.definition,
            id: nodeId,
            stepId: nodeId,
            dependencies: [this.id],
            kind: "composition",
            composition: "map",
        }, this.definitions, this.implementations);
    }
    mapEach(next) {
        const nodeId = Id.node();
        return new Node(nodeId, (input, context) => Effect.flatMap(this.execute(input, context), (items) => Effect.all(items.map((item) => (next instanceof Node ? next.execute(item, context) : toEffect(next(item)))), { concurrency: "unbounded" })), this.triggers, false, {
            ...this.definition,
            id: nodeId,
            stepId: nodeId,
            dependencies: [this.id, ...(next instanceof Node ? [next.id] : [])],
            kind: "fanout",
            composition: "map-each",
            ...(next instanceof Node ? { fanoutTemplate: next.id } : {}),
        }, [
            ...this.definitions,
            ...(next instanceof Node
                ? next.definitions.map((definition) => ({ ...definition, kind: "fanout-item" }))
                : []),
        ], [...this.implementations, ...(next instanceof Node ? next.implementations : [])]);
    }
    forEach(next) {
        const nodeId = Id.node();
        return new Node(nodeId, (input, context) => Effect.flatMap(this.execute(input, context), (items) => Effect.all(items.map((item) => next(new Node(Id.node(), () => Effect.succeed(item), [], false)).execute(item, context)), { concurrency: "unbounded" })), this.triggers, false, {
            ...this.definition,
            id: nodeId,
            stepId: nodeId,
            dependencies: [this.id],
            kind: "composition",
            composition: "forEach",
        }, this.definitions, this.implementations);
    }
    fanout(branches) {
        const nodeId = Id.node();
        return new Node(nodeId, (input, context) => Effect.flatMap(this.execute(input, context), (output) => Effect.all(Object.fromEntries(Object.entries(branches).map(([key, branch]) => [key, branch.execute(output, context)])), { concurrency: "unbounded" })), this.triggers, false, {
            ...this.definition,
            id: nodeId,
            stepId: nodeId,
            dependencies: [this.id, ...Object.values(branches).map((branch) => branch.id)],
            kind: "composition",
            composition: "fanout",
        }, [...this.definitions, ...Object.values(branches).flatMap((branch) => branch.definitions)], [...this.implementations, ...Object.values(branches).flatMap((branch) => branch.implementations)]);
    }
}
function toEffect(value) {
    return value && typeof value === "object" && "_tag" in value
        ? value
        : Effect.succeed(value);
}