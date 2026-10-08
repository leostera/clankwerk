import type { WorkflowSource } from "./scheduler.js"

/** Stable, bounded Durable Object name for a workflow's serialized event group. */
export async function workflowPartition(
  workflow: WorkflowSource,
  triggerId: string,
  value: unknown,
  eventKey: string,
): Promise<string> {
  if (!workflow.partition) return eventKey
  const identity = workflow.partition(triggerId, value)
  if (typeof identity !== "string" || !/^[a-zA-Z0-9._:/-]{1,256}$/.test(identity))
    throw new Error("Invalid workflow partition key")
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)))
  return `${workflow.id}:partition:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
