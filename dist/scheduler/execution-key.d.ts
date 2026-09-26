import type { ArtifactDigest } from "../artifacts/index.js";
import type { NodeDefinition } from "../core/index.js";
import type { WorkflowDefinitionHash } from "./manifest.js";
export type ExecutionKey = `sha256:${string}`;
export interface ExecutionKeyInput {
    readonly workflowDefinitionHash: WorkflowDefinitionHash;
    readonly task: NodeDefinition;
    readonly input: unknown;
    readonly inputArtifacts?: readonly ArtifactDigest[];
    /** Include agent/model/prompt/tool identity for agent task reuse. */
    readonly executor?: unknown;
}
/** Stable content key for explicitly cacheable task executions. */
export declare const createExecutionKey: (input: ExecutionKeyInput) => Promise<ExecutionKey>;