export * from "./artifacts.js";
export * from "./database.js";
export * from "./deployment.js";
export * from "./dynamic.js";
export * from "./durable.js";
export * from "./execution-key.js";
export * from "./manifest.js";
export * from "./materialize.js";
export * from "./migrations.js";
export * from "./operations.js";
export * from "./run-state.js";
export * from "./sqlite-schema.js";
export * from "./trigger-scheduler.js";
import { Effect } from "effect";
import type { EventId, NodeId, RunId, TriggerId, WorkflowRun } from "../core/index.js";
export type ExecutionEvent = {
    readonly type: "trigger.received";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly triggerId: TriggerId;
    readonly payload: unknown;
} | {
    readonly type: "workflow.scheduled";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly workflowId: NodeId;
} | {
    readonly type: "node.started";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly attempt: number;
} | {
    readonly type: "node.cache_hit";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly executionKey: string;
} | {
    readonly type: "node.completed";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly output: unknown;
    readonly durationMs: number;
} | {
    readonly type: "node.failed";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly error: unknown;
    readonly attempt: number;
} | {
    readonly type: "workflow.completed";
    readonly eventId: EventId;
    readonly runId: RunId;
    readonly status: WorkflowRun["status"];
};
export interface ExecutionEventStore {
    append(event: ExecutionEvent): Effect.Effect<void, unknown>;
    getRun(runId: RunId): Effect.Effect<readonly ExecutionEvent[], unknown>;
}
export declare class MemoryEventStore implements ExecutionEventStore {
    private readonly events;
    append(event: ExecutionEvent): Effect.Effect<void>;
    getRun(runId: RunId): Effect.Effect<readonly ExecutionEvent[]>;
}