import type { WorkflowSource } from "./scheduler.js"
import type { WebhookActivation } from "./webhook.js"
import { workflowPartition } from "./partition.js"

/** Dispatch one platform-scheduled tick to source-declared cron triggers. Replayed ticks deduplicate. */
export async function dispatchCron(
  schedule: string,
  scheduledTime: number,
  workflows: readonly WorkflowSource[],
  activate: (event: WebhookActivation) => Promise<unknown>,
): Promise<WebhookActivation[]> {
  if (!schedule || !Number.isFinite(scheduledTime) || scheduledTime < 0) throw new Error("Invalid scheduled trigger")
  const minute = Math.floor(scheduledTime / 60_000)
  const events: WebhookActivation[] = []
  for (const workflow of workflows) {
    for (const trigger of workflow.graph.triggers) {
      if (trigger.kind !== "cron" || trigger.schedule !== schedule) continue
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${trigger.id}:${minute}`)),
      )
      const key = `${workflow.id}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
      const value = trigger.value
      events.push({
        workflowId: workflow.id,
        triggerId: trigger.id,
        key,
        partition: await workflowPartition(workflow, trigger.id, value, key),
        value,
      })
    }
  }
  for (const event of events) await activate(event)
  return events
}
