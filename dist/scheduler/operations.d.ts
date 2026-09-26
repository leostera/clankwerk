import type { RunId } from "../core/index.js";
import type { WorkflowManifest } from "./manifest.js";
import type { NodeInstanceRecord, WorkflowRunRecord } from "./run-state.js";
import type { ExecutionEvent } from "./index.js";
export interface CreateRunInput {
    readonly workflowDefinitionHash: string;
    readonly triggerId: string;
    readonly input: unknown;
    readonly idempotencyKey?: string | undefined;
}
export interface SchedulerOperations {
    listWorkflows(): Promise<readonly WorkflowManifest[]>;
    listRuns(): Promise<readonly WorkflowRunRecord[]>;
    getRun(runId: RunId): Promise<WorkflowRunRecord | undefined>;
    getNodes(runId: RunId): Promise<readonly NodeInstanceRecord[]>;
    getEvents(runId: RunId): Promise<readonly ExecutionEvent[]>;
    trigger?(triggerId: string, input: unknown): Promise<readonly unknown[]>;
    createRun?(input: CreateRunInput): Promise<readonly unknown[]>;
}