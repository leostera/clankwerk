import { type ExecutionError } from "./errors.js";
import { type NodeId, type RunId, type TriggerId } from "./id.js";
import { type Node, type TriggerDefinition } from "./node.js";
import { type SchedulerObserver } from "./observer.js";
export interface RunSubmission {
    readonly id: RunId;
    readonly workflowId: NodeId;
    readonly triggerId: TriggerId;
    readonly status: "running";
}
export interface WorkflowRun {
    readonly id: RunId;
    readonly workflowId: NodeId;
    readonly triggerId: TriggerId;
    readonly status: "completed" | "failed";
    readonly output?: unknown;
    readonly error?: ExecutionError;
}
export interface Scheduler<Input = void, Output = unknown> {
    readonly workflows: readonly Node<Input, Output>[];
    readonly triggers: readonly TriggerDefinition[];
    /** Persists/schedules work and returns before the workflow completes when supported. */
    submitTrigger?(triggerId: TriggerId, value: unknown): Promise<RunSubmission[]>;
    runTrigger(triggerId: TriggerId, value: unknown): Promise<WorkflowRun[]>;
    run(): never;
}
export declare const createScheduler: <Input = void, Output = unknown>(options: {
    workflows: readonly Node<Input, Output>[];
    observer: SchedulerObserver;
}) => Scheduler<Input, Output>;