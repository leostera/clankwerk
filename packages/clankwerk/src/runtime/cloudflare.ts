import { WorkflowScheduler, type RunRecord, type RunStore, type SchedulerOptions } from "./scheduler.js"
import type { ReviewReceipt, ReviewReceiptStore } from "../connectors/github-pull.js"
import type { QueueState, QueuedActivation, WorkflowQueueStore } from "./queue.js"

/** Compose a run coordinator for one DO instance; project code supplies only its workflow registry and capabilities. */
export function cloudflareRunScheduler(
  ctx: DurableObjectState,
  options: Omit<SchedulerOptions, "id" | "store"> & { storageKey?: string },
): WorkflowScheduler {
  const { storageKey = "run", ...scheduler } = options
  return new WorkflowScheduler({
    ...scheduler,
    id: ctx.id.toString(),
    store: durableObjectRunStore(ctx.storage, storageKey),
  })
}

/** Cloudflare storage adapter; the run claim is atomic before any workflow task can execute. */
export function durableReviewReceipts(storage: DurableObjectStorage): ReviewReceiptStore {
  return {
    get: (key) => storage.get<ReviewReceipt>(key),
    reserve: (key, candidate) =>
      storage.transaction(async (tx) => {
        const existing = await tx.get<ReviewReceipt>(key)
        if (existing) return existing
        await tx.put(key, candidate)
        return candidate
      }),
    claim: (key, token, until) =>
      storage.transaction(async (tx) => {
        const current = await tx.get<ReviewReceipt>(key)
        if (!current) throw new Error("No reserved review receipt")
        if (current.reviewId) return current
        if (current.posting && current.posting.until > Date.now()) return undefined
        const claimed = { ...current, posting: { token, until } }
        await tx.put(key, claimed)
        return claimed
      }),
    complete: (key, receipt, token) =>
      storage.transaction(async (tx) => {
        const current = await tx.get<ReviewReceipt>(key)
        if (
          !current ||
          current.posting?.token !== token ||
          current.nonce !== receipt.nonce ||
          JSON.stringify(current.review) !== JSON.stringify(receipt.review)
        )
          return false
        await tx.put(key, { ...receipt, posting: undefined })
        return true
      }),
  }
}

export function durableObjectQueueStore(storage: DurableObjectStorage): WorkflowQueueStore {
  const empty = (): QueueState => ({ revision: 0, pending: [], rounds: 0 })
  return {
    read: async () => (await storage.get<QueueState>("workflow-queue")) ?? empty(),
    event: (key) => storage.get<QueuedActivation>(`workflow-event:${key}`),
    enqueue: (event, maxPending) =>
      storage.transaction(async (tx) => {
        const state = (await tx.get<QueueState>("workflow-queue")) ?? empty()
        if (await tx.get<QueuedActivation>(`workflow-event:${event.key}`)) return { accepted: false, state }
        if (state.blocked || state.pending.length >= maxPending)
          throw new Error("Workflow event queue is blocked or full")
        state.pending.push(event.key)
        state.revision++
        await tx.put(`workflow-event:${event.key}`, event)
        await tx.put("workflow-queue", state)
        return { accepted: true, state }
      }),
    compareAndWrite: (revision, state) =>
      storage.transaction(async (tx) => {
        const current = (await tx.get<QueueState>("workflow-queue")) ?? empty()
        if (current.revision !== revision || state.revision !== revision + 1) return false
        await tx.put("workflow-queue", state)
        return true
      }),
    schedule: (at) => storage.setAlarm(at),
  }
}

export function durableObjectRunStore(storage: DurableObjectStorage, key = "run"): RunStore {
  return {
    read: () => storage.get<RunRecord>(key),
    createIfAbsent: (candidate) =>
      storage.transaction(async (tx) => {
        const existing = await tx.get<RunRecord>(key)
        if (existing) return existing
        await tx.put(key, candidate)
        return candidate
      }),
    compareAndWrite: (revision, run) =>
      storage.transaction(async (tx) => {
        const current = await tx.get<RunRecord>(key)
        if (!current || current.revision !== revision || run.revision !== revision + 1) return false
        await tx.put(key, run)
        return true
      }),
    schedule: (at) => storage.setAlarm(at),
  }
}
