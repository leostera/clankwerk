import { Node } from "./node.js";
import { Id } from "./id.js";
export const Task = {
    fn(options) {
        const nodeId = graphNodeId(options.id);
        return new Node(nodeId, options.run, [], true, definition(options, nodeId), [], [], options.input, options.output);
    },
    effect(options) {
        const nodeId = graphNodeId(options.id);
        return new Node(nodeId, options.run, [], true, definition(options, nodeId), [], [], options.input, options.output);
    },
};
export const createStepRegistry = (workflows) => {
    const byStep = new Map(workflows.flatMap((workflow) => workflow.implementations.map((implementation) => [implementation.stepId, implementation.node])));
    return { get: (id) => byStep.get(id), definitions: () => workflows.flatMap((workflow) => workflow.definitions) };
};
export const createTaskRegistry = (tasks) => {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return {
        get: (id) => byId.get(id),
        definitions: () => [...byId.values()].map((task) => task.definition),
    };
};
function definition(options, nodeId) {
    const taskId = normalizeTaskId(options.id);
    return {
        id: nodeId,
        stepId: nodeId,
        taskId,
        description: options.description ?? Id.name(taskId),
        version: options.version ?? "1",
        cache: options.cache ?? "never",
        ...(options.executor === undefined ? {} : { executor: options.executor }),
        dependencies: [],
        retry: options.retry ?? { maxAttempts: 1, backoffMs: 1000 },
    };
}
function graphNodeId(id) {
    return Id.parse(id).kind === "node" ? id : Id.node();
}
function normalizeTaskId(id) {
    return Id.parse(id).kind === "task" ? id : Id.task(Id.name(id));
}