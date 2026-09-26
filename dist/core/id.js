/** Canonical LibClank URI construction and parsing. */
export const Id = {
    task: (value) => definition("task", value),
    // Node definitions are commonly constructed at Worker module scope, where Cloudflare
    // disallows random-value generation. Their process-local UUIDs are deterministic and
    // unique within the loaded graph; runtime identities below remain random.
    node: () => scopedUuid("node"),
    trigger: (value) => definition("trigger", value),
    workflow: (value) => definition("workflow", value),
    agent: (value) => definition("agent", value),
    artifact: (value) => definition("artifact", value),
    nodeInstance: () => runtimeUuid("node-instance"),
    parse: (value) => parseDefinition(value),
    name: (value) => parseDefinition(value).name,
    kind: (value) => parseDefinition(value).kind,
    run: () => crypto.randomUUID(),
    runFrom: (value) => isUuid(value)
        ? value
        : (() => {
            throw new Error(`Invalid run ID: ${value}`);
        })(),
    event: () => crypto.randomUUID(),
};
function definition(kind, value) {
    if (value.startsWith("clank:")) {
        const parsed = parseDefinition(value);
        if (parsed.kind !== kind)
            throw new Error(`Expected a clank ${kind} ID, received ${parsed.kind}`);
        return parsed.uri;
    }
    const name = normalizeName(value);
    return `clank:${kind}:${name.split("/").map(encodeURIComponent).join("/")}`;
}
let scopedNodeSequence = 0;
function scopedUuid(kind) {
    scopedNodeSequence += 1;
    const suffix = scopedNodeSequence.toString(16).padStart(12, "0");
    return `clank:${kind}:00000000-0000-4000-8000-${suffix}`;
}
function runtimeUuid(kind) {
    return `clank:${kind}:${crypto.randomUUID()}`;
}
function parseDefinition(value) {
    let kind;
    let encodedName;
    if (value.startsWith("clank:")) {
        const parts = value.slice("clank:".length).split(":");
        kind = parts.shift() ?? "";
        encodedName = parts.join(":");
    }
    else {
        throw new Error(`Invalid Clank definition ID: ${value}`);
    }
    if (!isDefinitionKind(kind) || encodedName.length === 0)
        throw new Error(`Invalid Clank definition ID: ${value}`);
    let name;
    try {
        name = normalizeName(encodedName.split("/").map(decodeURIComponent).join("/"));
    }
    catch {
        throw new Error(`Invalid Clank definition ID: ${value}`);
    }
    return { kind, name, uri: `clank:${kind}:${name.split("/").map(encodeURIComponent).join("/")}` };
}
function isDefinitionKind(value) {
    return (value === "task" ||
        value === "node" ||
        value === "trigger" ||
        value === "workflow" ||
        value === "agent" ||
        value === "artifact");
}
function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function normalizeName(value) {
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
        throw new Error(`LibClank definition names must contain a non-relative path: ${value}`);
    }
    return segments.join("/");
}