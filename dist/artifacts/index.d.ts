import { type ArtifactId } from "../core/index.js";
export type ArtifactDigest = `sha256:${string}`;
export type ArtifactBody = string | Uint8Array | ArrayBuffer;
export interface ArtifactRef {
    readonly id: ArtifactId;
    readonly digest: ArtifactDigest;
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
}
export interface PutArtifact {
    readonly name: string;
    readonly contentType: string;
    readonly body: ArtifactBody;
}
/** Immutable content-addressed artifact operations. */
export interface Artifacts {
    put(artifact: PutArtifact): Promise<ArtifactRef>;
    get(ref: ArtifactRef): Promise<Uint8Array>;
    has(digest: ArtifactDigest): Promise<boolean>;
}
export declare const Artifacts: {
    digest: (body: ArtifactBody) => Promise<ArtifactDigest>;
    ref: (artifact: PutArtifact) => Promise<ArtifactRef>;
    bytes: typeof bytes;
};
declare function bytes(body: ArtifactBody): Uint8Array;
export {};