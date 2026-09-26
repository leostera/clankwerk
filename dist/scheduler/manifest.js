import {} from "../core/index.js";
function isComposition(_id, task) {
    return task?.kind === "composition" || task?.composition !== undefined;
}
/** Compiles explicit composition metadata; graph behavior is never inferred from an ID suffix. */
function compositionEdges(tasks) {
    const byId = new Map(tasks.map((task) => [task.stepId, task]));
    const known = new Set(tasks.filter((task) => !isComposition(task.id, task)).map((task) => task.stepId));
    const output = (id, seen = new Set()) => {
        if (seen.has(id))
            throw new Error(`Composition graph contains a cycle at ${id}`);
        const task = byId.get(id);
        if (!task || task.kind !== "composition")
            return id;
        const next = task.composition === "then" ? task.dependencies[1] : task.dependencies[0];
        return next === undefined ? id : output(next, new Set(seen).add(id));
    };
    return tasks.flatMap((task) => {
        const [source, target, ...branches] = task.dependencies;
        if (!source)
            return [];
        if (task.composition === "then" || task.composition === "tap") {
            if (target === undefined)
                return [];
            const from = output(source);
            const to = output(target);
            return known.has(from) && known.has(to) ? [{ from, to, kind: "dependency" }] : [];
        }
        if (task.composition === "fanout" || task.kind === "fanout") {
            const from = output(source);
            return [target, ...branches]
                .filter((branch) => branch !== undefined)
                .map((branch) => ({ from, to: output(branch), kind: "dependency" }))
                .filter((edge) => known.has(edge.from) && known.has(edge.to));
        }
        return [];
    });
}
/** Builds a stable, hashable manifest from source-defined task and trigger metadata. */
export const createWorkflowManifest = async (source) => {
    const allTasks = [...new Map(source.tasks.map((task) => [task.stepId, task])).values()];
    const tasks = allTasks
        .filter((task) => !isComposition(task.id, task))
        .sort((left, right) => left.stepId.localeCompare(right.stepId));
    const triggers = (source.triggers ?? [])
        .map(({ id, nodeId, kind, path, schedule }) => ({
        id,
        ...(nodeId === undefined ? {} : { nodeId }),
        kind,
        ...(path === undefined ? {} : { path }),
        ...(schedule === undefined ? {} : { schedule }),
    }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const edges = [
        ...compositionEdges(allTasks),
        ...triggers.flatMap((trigger) => trigger.nodeId === undefined ? [] : [{ from: trigger.id, to: trigger.nodeId, kind: "trigger" }]),
    ];
    const canonical = JSON.stringify({ schemaVersion: 1, workflowId: source.workflowId, tasks, triggers, edges });
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const definitionHash = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return { schemaVersion: 1, workflowId: source.workflowId, definitionHash, tasks, triggers, edges };
};