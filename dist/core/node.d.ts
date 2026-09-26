import { Effect, type Schema } from "effect";
import { type NodeId, type TaskId, type TriggerId } from "./id.js";
import { type SchedulerObserver } from "./observer.js";
export interface ExecutionContext {
    readonly triggerValues: ReadonlyMap<TriggerId, unknown>;
    readonly runId?: import("./id.js").RunId;
    /** Persisted node-instance identity; unlike nodeId it is unique per workflow run. */
    readonly nodeInstanceId?: string;
    /** One-based durable execution attempt. Undefined for eager execution. */
    readonly attempt?: number;
    readonly nodeId?: NodeId;
    readonly observer?: SchedulerObserver;
}
export type RuntimeSchema<T> = Schema.Schema<T> & Schema.ConstraintDecoder<unknown, never>;
export type NodeRun<Output> = Effect.Effect<Output, unknown, never>;
export type NodeFunction<Input, Output> = (input: Input, context?: ExecutionContext) => NodeRun<Output>;
/** A source-loaded executable for one workflow step; the function itself is never persisted. */
export interface StepImplementation {
    readonly stepId: NodeId;
    readonly node: Node<unknown, unknown>;
}
/** Source-defined metadata persisted by durable schedulers; executable closures are never persisted. */
export interface NodeDefinition {
    readonly id: NodeId;
    readonly stepId: NodeId;
    /** Named source definition executed by this graph node. */
    readonly taskId?: TaskId;
    readonly description: string;
    readonly version: string;
    readonly cache: "never" | "by-input";
    /** Stable executor identity included in cache keys for cacheable tasks. */
    readonly executor?: unknown;
    readonly dependencies: readonly NodeId[];
    readonly retry: {
        readonly maxAttempts: number;
        readonly backoffMs: number;
    };
    readonly kind?: "static" | "fanout-item" | "fanout" | "composition";
    readonly composition?: "then" | "tap" | "map" | "map-each" | "forEach" | "fanout";
    readonly fanoutTemplate?: NodeId;
}
export interface TriggerDefinition<Output = unknown> {
    readonly id: TriggerId;
    /** Graph node activated by this trigger. */
    readonly nodeId?: NodeId;
    readonly kind: "webhook" | "cron" | "manual";
    readonly path?: string;
    readonly schedule?: string;
    readonly decode?: (request: Request) => Output | Promise<Output>;
}
export declare class Node<Input, Output> {
    readonly id: NodeId;
    readonly triggers: readonly TriggerDefinition[];
    readonly observable: boolean;
    readonly definition: NodeDefinition;
    /** A function property intentionally makes Input contravariant and Output covariant. */
    readonly execute: (input: Input, context?: ExecutionContext) => NodeRun<Output>;
    readonly definitions: readonly NodeDefinition[];
    readonly implementations: readonly StepImplementation[];
    readonly inputSchema: RuntimeSchema<Input> | undefined;
    readonly outputSchema: RuntimeSchema<Output> | undefined;
    constructor(id: NodeId, run: NodeFunction<Input, Output>, triggers?: readonly TriggerDefinition[], observable?: boolean, definition?: NodeDefinition, definitions?: readonly NodeDefinition[], implementations?: readonly StepImplementation[], inputSchema?: RuntimeSchema<Input>, outputSchema?: RuntimeSchema<Output>);
    then<Next>(next: Node<Output, Next>): Node<Input, Next>;
    then<Next>(next: (output: Output) => NodeRun<Next> | Next): Node<Input, Next>;
    tap(effect: Node<Output, unknown>): Node<Input, Output>;
    map<Next>(transform: (output: Output) => Next): Node<Input, Next>;
    mapEach<Item, Next>(this: Node<Input, readonly Item[]>, next: Node<Item, Next>): Node<Input, readonly Next[]>;
    mapEach<Item, Next>(this: Node<Input, readonly Item[]>, next: (item: Item) => NodeRun<Next> | Next): Node<Input, readonly Next[]>;
    forEach<Item, Next>(this: Node<Input, readonly Item[]>, next: (item: Node<Item, Item>) => Node<unknown, Next>): Node<Input, readonly Next[]>;
    fanout<Branches extends Record<string, Node<unknown, unknown>>>(branches: Branches): Node<Input, FanoutOutputs<Branches>>;
}
export type NodeInput<N> = N extends Node<infer Input, unknown> ? Input : never;
export type NodeOutput<N> = N extends Node<unknown, infer Output> ? Output : never;
export type FanoutOutputs<B extends Record<string, Node<unknown, unknown>>> = {
    [K in keyof B]: NodeOutput<B[K]>;
};
export type Trigger<Output> = Node<void, Output>;
export type EffectNode<Input> = Node<Input, void>;