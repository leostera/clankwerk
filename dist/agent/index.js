import { Effect } from "effect";
import { ExecutionFailure, Task as CoreTask, } from "../core/index.js";
export const AGENT_TASK_PROTOCOL_VERSION = 1;
/** A protocol failure returned by a team-owned AgentRuntime. */
export class AgentTaskError extends ExecutionFailure {
    retryable;
    constructor(message, retryable) {
        super(message, retryable ? "retryable" : "permanent");
        this.retryable = retryable;
        this.name = "AgentTaskError";
    }
}
export const Task = {
    ...CoreTask,
    agent(options) {
        const executorIdentity = {
            protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
            endpoint: options.endpoint.identity ?? null,
            instructions: options.instructions,
            model: options.model ?? null,
            skills: [...(options.skills ?? [])].sort(),
            ...(options.executor === undefined ? {} : { application: options.executor }),
        };
        return CoreTask.fn({
            id: options.id,
            description: options.description ?? options.instructions,
            cache: options.cache ?? "by-input",
            ...(options.version === undefined ? {} : { version: options.version }),
            ...(options.retry === undefined ? {} : { retry: options.retry }),
            executor: executorIdentity,
            run: (input, context) => {
                const runId = context?.runId;
                if (!runId)
                    return Effect.die(new Error(`Agent task ${options.id} requires a workflow run ID`));
                const attempt = context?.attempt ?? 1;
                const nodeInstanceId = context?.nodeInstanceId ?? `${runId}:${options.id}`;
                return options.endpoint.run({
                    version: AGENT_TASK_PROTOCOL_VERSION,
                    runId,
                    nodeId: options.id,
                    nodeInstanceId,
                    executionToken: `${runId}:${nodeInstanceId}:${attempt}`,
                    attempt,
                    input,
                    instructions: options.instructions,
                    executorIdentity,
                    ...(options.model === undefined ? {} : { model: options.model }),
                    ...(options.skills === undefined ? {} : { skills: options.skills }),
                });
            },
        });
    },
};