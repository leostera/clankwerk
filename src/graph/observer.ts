import type { NodeId, RunId, TriggerId } from "./id.js"

export interface SchedulerObserver {
  triggerReceived(event: { readonly triggerId: TriggerId; readonly payload: unknown }): void
  workflowScheduled(event: { readonly runId: RunId; readonly workflowId: NodeId }): void
  nodeStarted(event: { readonly runId?: RunId; readonly nodeId: NodeId }): void
  nodeCompleted(event: {
    readonly runId?: RunId
    readonly nodeId: NodeId
    readonly output: unknown
    readonly durationMs: number
  }): void
  nodeFailed(event: {
    readonly runId?: RunId
    readonly nodeId: NodeId
    readonly error: unknown
    readonly durationMs: number
  }): void
  workflowCompleted(event: {
    readonly runId: RunId
    readonly workflowId: NodeId
    readonly status: "completed" | "failed"
  }): void
}

export const SchedulerObservers = {
  noop: {
    triggerReceived: () => {},
    workflowScheduled: () => {},
    nodeStarted: () => {},
    nodeCompleted: () => {},
    nodeFailed: () => {},
    workflowCompleted: () => {},
  } satisfies SchedulerObserver,
} as const

/** Observer failures are non-fatal: observability must never stop scheduling. */
export function notify(callback: () => void): void {
  try {
    callback()
  } catch {
    /* intentionally ignored */
  }
}
