import { type NodeId, type RunId, type SchedulerObserver } from "../core/index.js";
import type { SchedulerDatabase } from "./database.js";
import type { TaskRegistry } from "../core/index.js";
export interface RetryPolicy {
    readonly maxAttempts: number;
    readonly backoffMs: (attempt: number) => number;
}
/** Durable local/DO-compatible execution loop. The database, not the call stack, is authoritative. */
export declare class DurableTaskScheduler {
    private readonly options;
    constructor(options: {
        readonly database: SchedulerDatabase;
        readonly tasks: TaskRegistry;
        readonly observer?: SchedulerObserver;
        readonly retry?: RetryPolicy;
        readonly leaseMs?: number;
        readonly triggerValues?: ReadonlyMap<import("../core/index.js").TriggerId, unknown>;
    });
    recover(now?: number): Promise<void>;
    tick(now?: number): Promise<number>;
    private execute;
}
export interface DurableNodeInput {
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly input: unknown;
}