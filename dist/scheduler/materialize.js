import { Id } from "../core/index.js";
/** Creates durable step instances and dependency rows from a registered static manifest. */
export const materializeWorkflowRun = async (options) => {
    const tasks = options.manifest.tasks.filter((task) => task.kind !== "fanout-item");
    const dependencyTargets = new Set(options.manifest.edges
        .filter((edge) => edge.kind === "dependency" && tasks.some((task) => task.stepId === edge.to))
        .map((edge) => edge.to));
    const instances = tasks.map((task) => ({
        id: Id.nodeInstance(),
        runId: options.run.id,
        nodeId: task.stepId,
        status: dependencyTargets.has(task.stepId) ? "pending" : "ready",
        input: options.input,
        inputArtifacts: [],
        attempt: 0,
    }));
    for (const instance of instances)
        await options.database.putNode(instance);
    const instanceByStep = new Map(instances.map((instance) => [String(instance.nodeId), instance.id]));
    for (const edge of options.manifest.edges.filter((edge) => edge.kind === "dependency" &&
        tasks.some((task) => task.stepId === edge.to) &&
        tasks.some((task) => task.stepId === edge.from))) {
        const target = instanceByStep.get(edge.to);
        const dependency = instanceByStep.get(edge.from);
        if (target && dependency)
            await options.database.putDependency?.(options.run.id, target, dependency);
    }
    return instances;
};