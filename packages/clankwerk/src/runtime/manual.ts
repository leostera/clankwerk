import { Id } from "../graph/id.js"
import type { WorkflowSource } from "./scheduler.js"
import type { WebhookActivation } from "./webhook.js"
import { workflowPartition } from "./partition.js"

/** An authenticated host activates a declared manual trigger, not an arbitrary task by workflow ID. */
export async function dispatchManual(
  triggerId: string,
  value: unknown,
  workflows: readonly WorkflowSource[],
  activate: (event: WebhookActivation) => Promise<unknown>,
  id = crypto.randomUUID(),
): Promise<WebhookActivation[]> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid manual activation ID")
  const matching = workflows.flatMap((workflow) =>
    workflow.graph.triggers
      .filter((trigger) => trigger.kind === "manual" && trigger.id === triggerId)
      .map((trigger) => ({ workflow, trigger })),
  )
  const events: WebhookActivation[] = []
  for (const { workflow, trigger } of matching) {
    const identity = `${Id.name(trigger.id)}:${id}`
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)))
    const key = `${workflow.id}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    events.push({
      workflowId: workflow.id,
      triggerId: trigger.id,
      key,
      partition: await workflowPartition(workflow, trigger.id, value, key),
      value,
    })
  }
  for (const event of events) await activate(event)
  return events
}
