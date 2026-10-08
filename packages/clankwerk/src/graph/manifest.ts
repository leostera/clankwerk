import { Id, type TriggerId, type WorkflowId } from "./id.js"
import type { NodeDefinition, TriggerDefinition } from "./node.js"

export type WorkflowDefinitionHash = `sha256:${string}`

/** Persistable source metadata used to identify compatible task implementations on resume. */
export interface WorkflowManifest {
  readonly schemaVersion: 1
  readonly workflowId: WorkflowId
  readonly definitionHash: WorkflowDefinitionHash
  readonly tasks: readonly NodeDefinition[]
  readonly triggers: readonly PersistedTriggerDefinition[]
  readonly edges: readonly WorkflowManifestEdge[]
}

export interface WorkflowManifestEdge {
  readonly from: string
  readonly to: string
  readonly kind: "dependency" | "trigger"
  /** Static fan-out output name when multiple branch results join. */
  readonly as?: string
}

export interface WorkflowManifestSource {
  readonly workflowId: WorkflowId
  readonly tasks: readonly NodeDefinition[]
  readonly triggers?: readonly TriggerDefinition[]
}

export interface PersistedTriggerDefinition {
  readonly id: TriggerId
  readonly kind: TriggerDefinition["kind"]
  readonly path?: string
  readonly schedule?: string
  readonly value?: unknown
}

function isComposition(id: string, task?: NodeDefinition): boolean {
  if (task?.kind === "fanout") return false
  return /\/(then|tap|map|map-each|forEach|fanout)$/.test(id)
}

function compositionEdges(tasks: readonly NodeDefinition[]): WorkflowManifestEdge[] {
  const byId = new Map<string, NodeDefinition>()
  for (const task of tasks) if (!byId.has(task.id)) byId.set(task.id, task)
  const outputs = (id: string): string[] => {
    const task = byId.get(id)
    if (task && /\/tap$/.test(id) && task.dependencies[1]) {
      const composedOutput = tasks.find(
        (candidate) => candidate.stepId === Id.childNode(task.stepId, Id.name(task.dependencies[1]!)),
      )
      return [composedOutput?.stepId ?? task.stepId]
    }
    if (task && /\/then$/.test(id) && task.dependencies[1]) return outputs(task.dependencies[1])
    // A static fan-out has no executable join node: its outputs are the branches.
    if (task && /\/fanout$/.test(id) && task.kind !== "fanout") return task.dependencies.slice(1).flatMap(outputs)
    return [task?.stepId ?? id]
  }
  const input = (id: string): string => {
    const task = byId.get(id)
    return task && /(then|tap)$/.test(id) && task.dependencies[0] ? input(task.dependencies[0]) : (task?.stepId ?? id)
  }
  const tapOutput = (task: NodeDefinition): string => {
    const dependency = task.dependencies[1]
    if (!dependency) return task.stepId
    return (
      tasks.find((candidate) => candidate.stepId === Id.childNode(task.stepId, Id.name(dependency)))?.stepId ??
      task.stepId
    )
  }
  return tasks.flatMap((task) => {
    if ((task.id.endsWith("/then") || task.id.endsWith("/tap")) && task.dependencies[0] && task.dependencies[1]) {
      const parent = byId.get(task.dependencies[0])
      if (task.id.endsWith("/then") && parent?.id.endsWith("/fanout") && parent.branchKeys) {
        if (parent.branchKeys.length !== parent.dependencies.length - 1)
          throw new Error("Invalid static fan-out branch keys")
        return parent.dependencies.slice(1).flatMap((branch, index) =>
          outputs(branch).map((from) => ({
            from,
            to: input(task.dependencies[1]!),
            kind: "dependency" as const,
            as: parent.branchKeys![index],
          })),
        )
      }
      return outputs(task.dependencies[0]).map((from) => ({
        from,
        to: task.id.endsWith("/tap") ? tapOutput(task) : input(task.dependencies[1]!),
        kind: "dependency" as const,
      }))
    }
    if ((task.id.endsWith("/fanout") || task.kind === "fanout") && task.dependencies[0])
      return task.kind === "fanout"
        ? outputs(task.dependencies[0]).map((from) => ({ from, to: task.stepId, kind: "dependency" as const }))
        : task.dependencies.slice(1).flatMap((branch) =>
            outputs(task.dependencies[0]!).map((from) => ({
              from,
              to: input(branch),
              kind: "dependency" as const,
            })),
          )
    return []
  })
}

/** Builds a stable, hashable manifest from source-defined task and trigger metadata. */
export const createWorkflowManifest = async (source: WorkflowManifestSource): Promise<WorkflowManifest> => {
  const allTasks = [...new Map(source.tasks.map((task) => [task.stepId, task])).values()]
  const tasks = allTasks
    .filter((task) => !isComposition(task.id, task))
    .sort((left, right) => left.id.localeCompare(right.id))
  const triggers = (source.triggers ?? [])
    .map(({ id, kind, path, schedule, value }) => ({
      id,
      kind,
      ...(path === undefined ? {} : { path }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(kind !== "cron" || value === undefined ? {} : { value }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const edges: WorkflowManifestEdge[] = [
    ...compositionEdges(allTasks),
    ...triggers.map((trigger) => ({
      from: trigger.id,
      to:
        tasks.find((task) => task.kind === "trigger-selector" && task.triggerIds?.includes(trigger.id))?.stepId ??
        Id.nodeFromTrigger(trigger.id),
      kind: "trigger" as const,
    })),
  ]
  const canonical = JSON.stringify({ schemaVersion: 1, workflowId: source.workflowId, tasks, triggers, edges })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource)
  const definitionHash =
    `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}` as WorkflowDefinitionHash
  return { schemaVersion: 1, workflowId: source.workflowId, definitionHash, tasks, triggers, edges }
}
