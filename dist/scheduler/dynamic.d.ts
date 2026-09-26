import type { NodeInstanceRecord, WorkflowRunRecord } from "./run-state.js";
import type { SchedulerDatabase } from "./database.js";
import type { NodeDefinition } from "../core/index.js";
/** Materializes one durable step instance per collection item for a map template. */
export declare const materializeDynamicSteps: (options: {
    readonly database: SchedulerDatabase;
    readonly run: Pick<WorkflowRunRecord, "id">;
    readonly template: NodeDefinition;
    readonly items: readonly unknown[];
    readonly inputArtifacts?: readonly import("../artifacts/index.js").ArtifactRef[];
}) => Promise<readonly NodeInstanceRecord[]>;