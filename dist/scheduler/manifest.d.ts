import { type NodeDefinition, type NodeId, type TriggerDefinition, type TriggerId, type WorkflowId } from "../core/index.js";
export type WorkflowDefinitionHash = `sha256:${string}`;
/** Persistable source metadata used to identify compatible task implementations on resume. */
export interface WorkflowManifest {
    readonly schemaVersion: 1;
    readonly workflowId: WorkflowId;
    readonly definitionHash: WorkflowDefinitionHash;
    readonly tasks: readonly NodeDefinition[];
    readonly triggers: readonly PersistedTriggerDefinition[];
    readonly edges: readonly WorkflowManifestEdge[];
}
export interface WorkflowManifestEdge {
    readonly from: string;
    readonly to: string;
    readonly kind: "dependency" | "trigger";
}
export interface WorkflowManifestSource {
    readonly workflowId: WorkflowId;
    readonly tasks: readonly NodeDefinition[];
    readonly triggers?: readonly TriggerDefinition[];
}
export interface PersistedTriggerDefinition {
    readonly id: TriggerId;
    readonly nodeId?: NodeId;
    readonly kind: TriggerDefinition["kind"];
    readonly path?: string;
    readonly schedule?: string;
}
/** Builds a stable, hashable manifest from source-defined task and trigger metadata. */
export declare const createWorkflowManifest: (source: WorkflowManifestSource) => Promise<WorkflowManifest>;