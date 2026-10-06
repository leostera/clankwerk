export { Id } from "./graph/id.js"
export { Node } from "./graph/node.js"
export { Task } from "./graph/task.js"
export { Triggers } from "./graph/trigger.js"
export { Workflow } from "./graph/workflow.js"
export { createWorkflowManifest } from "./graph/manifest.js"
export type { NodeDefinition, TriggerDefinition } from "./graph/node.js"

export interface AgentDefinition<T> {
  readonly id: string
  readonly agent: T
}

export interface WorkflowDefinition<T> {
  readonly id: string
  readonly graph: T
}

export const Clankwerk = {
  defineAgent<T>(definition: AgentDefinition<T>): AgentDefinition<T> {
    if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) throw new Error("Agent IDs must be kebab-case")
    return definition
  },
  defineWorkflow<T>(definition: WorkflowDefinition<T>): WorkflowDefinition<T> {
    if (!/^[a-z][a-z0-9-]*$/.test(definition.id)) throw new Error("Workflow IDs must be kebab-case")
    return definition
  },
}
