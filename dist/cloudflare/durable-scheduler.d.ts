import type { RunId } from "../core/index.js";
export interface DurableSql {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): {
        toArray(): T[];
    };
}
export interface DurableRunState {
    readonly storage: {
        readonly sql: DurableSql;
        putAlarm?(time: number | Date): Promise<void>;
        getAlarm?(): Promise<number | null>;
    };
    readonly waitUntil: (promise: Promise<unknown>) => void;
}
export interface DurableTaskExecutor {
    execute(input: {
        readonly runId: RunId;
        readonly nodeId: string;
        readonly attempt: number;
        readonly input: unknown;
    }): Promise<unknown>;
}
/** Durable Object-compatible persisted run coordinator. Use one instance per workflow run. */
export declare class CloudflareWorkflowRun {
    private readonly state;
    private readonly executor;
    constructor(state: DurableRunState, executor: DurableTaskExecutor);
    start(runId: RunId, nodeId: string, input: unknown): Promise<void>;
    tick(runId: RunId): Promise<void>;
    alarm(runId: RunId): Promise<void>;
    private append;
}