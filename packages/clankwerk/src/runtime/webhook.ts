import type { WorkflowSource } from "./scheduler.js"
import type { TriggerDefinition } from "../graph/node.js"
import { workflowPartition } from "./partition.js"

export interface WebhookActivation {
  workflowId: string
  triggerId: string
  /** Namespaced by workflow ID by the dispatcher. Use this as the durable run's deterministic name. */
  key: string
  partition: string
  value: unknown
}

/** Stable key and partition shared by generic and source-authenticated webhook adapters. */
export async function keyedWebhookActivation(
  workflow: WorkflowSource,
  trigger: TriggerDefinition,
  value: unknown,
): Promise<WebhookActivation> {
  if (!trigger.key) throw new Error("Incomplete webhook trigger")
  const identity = trigger.key(value)
  if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(identity)) throw new Error("Invalid webhook activation key")
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)))
  const suffix = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  const key = `${workflow.id}:${suffix}`
  const partition = await workflowPartition(workflow, trigger.id, value, key)
  return { workflowId: workflow.id, triggerId: trigger.id, key, partition, value }
}

/** Dispatch declared webhook triggers; the HTTP host supplies only the durable run launcher. */
export async function dispatchWebhook(
  request: Request,
  workflows: readonly WorkflowSource[],
  activate: (event: WebhookActivation) => Promise<unknown>,
  maxBytes = 1_048_576,
): Promise<WebhookActivation[]> {
  if (request.method !== "POST") return []
  const path = new URL(request.url).pathname
  const matching = workflows.flatMap((workflow) =>
    workflow.graph.triggers
      .filter((trigger) => trigger.kind === "webhook" && trigger.path === path && trigger.decode)
      .map((trigger) => ({ workflow, trigger })),
  )
  if (!matching.length) return []
  if (Number(request.headers.get("content-length")) > maxBytes) throw new Error("Webhook body exceeds limit")
  const reader = request.body?.getReader()
  if (!reader) throw new Error("Missing webhook body")
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error("Webhook body exceeds limit")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const replay = () => new Request(request.url, { method: "POST", headers: request.headers, body: bytes.slice() })
  // Authenticate *all* matching declarations before activating any workflow on a shared endpoint.
  for (const { trigger } of matching) {
    if (!trigger.verify || !trigger.key || !trigger.decode) throw new Error("Incomplete webhook trigger")
    await trigger.verify(replay())
  }
  const events: WebhookActivation[] = []
  for (const { workflow, trigger } of matching) {
    const value = await trigger.decode!(replay())
    if (value === undefined) continue
    events.push(await keyedWebhookActivation(workflow, trigger, value))
  }
  for (const event of events) await activate(event)
  return events
}
