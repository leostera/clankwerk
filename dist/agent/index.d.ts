import { ExecutionFailure, Task as CoreTask, type NodeDefinition, type NodeId, type NodeRun, type RunId, type Task as TaskNode } from "../core/index.js";
export declare const AGENT_TASK_PROTOCOL_VERSION: 1;
/** Request sent by the scheduler to a team-owned AgentRuntime. */
export interface AgentTaskRequest<Input = unknown> {
    readonly version: typeof AGENT_TASK_PROTOCOL_VERSION;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    /** Unique persisted instance of this task within the workflow run. */
    readonly nodeInstanceId: string;
    /** Stable at-least-once execution identity for this exact attempt. */
    readonly executionToken: string;
    readonly attempt: number;
    readonly input: Input;
    readonly instructions: string;
    /** Cache and deployment identity for the executor selected by the workflow. */
    readonly executorIdentity: unknown;
    readonly model?: string;
    readonly skills?: readonly string[];
}
export type AgentTaskResponse<Output = unknown> = {
    readonly ok: true;
    readonly output: Output;
} | {
    readonly ok: false;
    readonly error: {
        readonly message: string;
        readonly retryable: boolean;
    };
};
/** A protocol failure returned by a team-owned AgentRuntime. */
export declare class AgentTaskError extends ExecutionFailure {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean);
}
/** Server-side implementation owned and deployed by the application team. */
export interface AgentRuntime {
    execute<Input, Output>(request: AgentTaskRequest<Input>): NodeRun<AgentTaskResponse<Output>>;
}
/** Client-side handle used by the scheduler to reach an AgentRuntime. */
export interface AgentEndpoint {
    /** Stable deployment/transport identity included in cacheable Agent task keys. */
    readonly identity?: unknown;
    run<Input, Output>(request: AgentTaskRequest<Input>): NodeRun<Output>;
}
export declare const Task: {
    agent<Input, Output>(options: {
        id: NodeId;
        instructions: string;
        endpoint: AgentEndpoint;
        model?: string;
        skills?: readonly string[];
        description?: string;
        version?: string;
        /** Agents cache immutable outputs by input unless explicitly disabled. */
        cache?: NodeDefinition["cache"];
        retry?: NodeDefinition["retry"];
        /** Adds application-owned model, tool, or tenant identity to cache keys. */
        executor?: NodeDefinition["executor"];
    }): TaskNode<Input, Output>;
    fn<Input, Output>(options: import("../core/index.js").TaskOptions<Input, Output>): CoreTask<Input, Output>;
    effect<Input>(options: import("../core/index.js").TaskOptions<Input, void>): import("../core/index.js").EffectNode<Input>;
};