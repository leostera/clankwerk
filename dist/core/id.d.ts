declare const opaque: unique symbol;
export type Opaque<T, Brand extends string> = T & {
    readonly [opaque]: Brand;
};
export type TaskId = Opaque<string, "TaskId">;
export type NodeId = Opaque<string, "NodeId">;
export type TriggerId = Opaque<string, "TriggerId">;
export type RunId = Opaque<string, "RunId">;
export type EventId = Opaque<string, "EventId">;
export type WorkflowId = Opaque<string, "WorkflowId">;
export type AgentId = Opaque<string, "AgentId">;
export type ArtifactId = Opaque<string, "ArtifactId">;
export type NodeInstanceId = Opaque<string, "NodeInstanceId">;
export type DefinitionId = TaskId | NodeId | TriggerId | WorkflowId | AgentId | ArtifactId;
export type DefinitionKind = "task" | "node" | "trigger" | "workflow" | "agent" | "artifact";
export interface ParsedDefinitionId {
    readonly kind: DefinitionKind;
    readonly name: string;
    readonly uri: DefinitionId;
}
/** Canonical LibClank URI construction and parsing. */
export declare const Id: {
    task: (value: string) => TaskId;
    node: () => NodeId;
    trigger: (value: string) => TriggerId;
    workflow: (value: string) => WorkflowId;
    agent: (value: string) => AgentId;
    artifact: (value: string) => ArtifactId;
    nodeInstance: () => NodeInstanceId;
    parse: (value: string) => ParsedDefinitionId;
    name: (value: DefinitionId) => string;
    kind: (value: DefinitionId) => DefinitionKind;
    run: () => RunId;
    runFrom: (value: string) => RunId;
    event: () => EventId;
};
export {};