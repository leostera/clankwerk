import type { ArtifactRef } from "../artifacts/index.js";
/** Durable task payload shape. Values may remain JSON while large data travels as immutable artifacts. */
export interface ArtifactBackedInput {
    readonly value?: unknown;
    readonly artifacts: readonly ArtifactRef[];
}
export interface ArtifactBackedOutput {
    readonly value?: unknown;
    readonly artifacts: readonly ArtifactRef[];
}
export declare const artifactInput: (artifacts: readonly ArtifactRef[], value?: unknown) => ArtifactBackedInput;
export declare const artifactOutput: (artifacts: readonly ArtifactRef[], value?: unknown) => ArtifactBackedOutput;