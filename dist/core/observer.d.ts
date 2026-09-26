import type { NodeId, RunId, TriggerId } from "./id.js";
export interface SchedulerObserver {
    triggerReceived(event: {
        readonly triggerId: TriggerId;
        readonly payload: unknown;
    }): void;
    workflowScheduled(event: {
        readonly runId: RunId;
        readonly workflowId: NodeId;
    }): void;
    nodeStarted(event: {
        readonly runId?: RunId;
        readonly nodeId: NodeId;
    }): void;
    nodeCompleted(event: {
        readonly runId?: RunId;
        readonly nodeId: NodeId;
        readonly output: unknown;
        readonly durationMs: number;
    }): void;
    nodeFailed(event: {
        readonly runId?: RunId;
        readonly nodeId: NodeId;
        readonly error: unknown;
        readonly durationMs: number;
    }): void;
    workflowCompleted(event: {
        readonly runId: RunId;
        readonly workflowId: NodeId;
        readonly status: "completed" | "failed";
    }): void;
}
export declare const SchedulerObservers: {
    readonly noop: {
        triggerReceived: () => void;
        workflowScheduled: () => void;
        nodeStarted: () => void;
        nodeCompleted: () => void;
        nodeFailed: () => void;
        workflowCompleted: () => void;
    };
};
/** Observer failures are non-fatal: observability must never stop scheduling. */
export declare function notify(callback: () => void): void;