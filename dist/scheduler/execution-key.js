/** Stable content key for explicitly cacheable task executions. */
export const createExecutionKey = async (input) => {
    const canonical = canonicalJson({
        workflowDefinitionHash: input.workflowDefinitionHash,
        task: input.task,
        input: input.input,
        inputArtifacts: [...(input.inputArtifacts ?? [])].sort(),
        executor: input.executor ?? null,
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    throw new TypeError(`Execution key inputs must be JSON values; received ${typeof value}`);
}