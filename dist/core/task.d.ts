import { Node, type EffectNode, type NodeDefinition, type NodeFunction, type RuntimeSchema } from "./node.js";
import { type NodeId, type TaskId } from "./id.js";
export type Task<Input, Output> = Node<Input, Output>;
export type TaskOptions<Input, Output> = {
    readonly id: TaskId | NodeId;
    readonly run: NodeFunction<Input, Output>;
    readonly description?: string;
    readonly version?: string;
    /** Only use `by-input` for work with reusable immutable outputs. */
    readonly cache?: NodeDefinition["cache"];
    /** Stable implementation identity included in cache keys for cacheable work. */
    readonly executor?: NodeDefinition["executor"];
    readonly retry?: NodeDefinition["retry"];
    readonly input?: RuntimeSchema<Input>;
    readonly output?: RuntimeSchema<Output>;
};
export declare const Task: {
    fn<Input, Output>(options: TaskOptions<Input, Output>): Task<Input, Output>;
    effect<Input>(options: TaskOptions<Input, void>): EffectNode<Input>;
};
/** Resolves persisted task IDs back to source-loaded implementations during retry. */
export interface TaskRegistry {
    get(id: NodeId): Node<unknown, unknown> | undefined;
    definitions(): readonly NodeDefinition[];
}
export declare const createStepRegistry: (workflows: readonly Node<unknown, unknown>[]) => TaskRegistry;
export declare const createTaskRegistry: (tasks: readonly Node<unknown, unknown>[]) => TaskRegistry;