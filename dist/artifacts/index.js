import { Id } from "../core/index.js";
export const Artifacts = {
    digest: async (body) => {
        const hash = await crypto.subtle.digest("SHA-256", bytes(body));
        return `sha256:${toHex(new Uint8Array(hash))}`;
    },
    ref: async (artifact) => {
        const body = bytes(artifact.body);
        const digest = await Artifacts.digest(body);
        return {
            id: Id.artifact(digest),
            digest,
            name: artifact.name,
            contentType: artifact.contentType,
            size: body.byteLength,
        };
    },
    bytes,
};
function bytes(body) {
    if (typeof body === "string")
        return new TextEncoder().encode(body);
    return body instanceof ArrayBuffer ? new Uint8Array(body) : body;
}
function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}