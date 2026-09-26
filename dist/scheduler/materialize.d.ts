import type { NodeInstanceRecord, WorkflowRunRecord } from "./run-state.js";
import type { SchedulerDatabase } from "./database.js";
import type { WorkflowManifest } from "./manifest.js";
/** Creates durable step instances and dependency rows from a registered static manifest. */
export declare const materializeWorkflowRun: (options: {
    readonly database: SchedulerDatabase;
    readonly run: WorkflowRunRecord;
    readonly manifest: WorkflowManifest;
    readonly input: unknown;
}) => Promise<readonly NodeInstanceRecord[]>;