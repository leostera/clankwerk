import type { RunRecord } from "./scheduler.js"
import { WorkflowScheduler } from "./scheduler.js"

export type QueuedActivation = {
  key: string
  workflowId: string
  input: unknown
  trigger: NonNullable<RunRecord["trigger"]>
}
export type QueueState = {
  revision: number
  active?: string
  pending: string[]
  rounds: number
  blocked?: string
}

/** A queue is one coordination atom, e.g. a repository and issue number. Individual runs remain separate. */
export interface WorkflowQueueStore {
  read(): Promise<QueueState>
  /** Atomically deduplicate the event and append its key without rewriting prior run records. */
  enqueue(event: QueuedActivation, maxPending: number): Promise<{ accepted: boolean; state: QueueState }>
  event(key: string): Promise<QueuedActivation | undefined>
  compareAndWrite(expectedRevision: number, state: QueueState): Promise<boolean>
  schedule(at: number): Promise<void>
}

export interface WorkflowQueueOptions {
  store: WorkflowQueueStore
  /** Provides a separate durable run store for each event key, but uses the same queue alarm. */
  scheduler: (key: string) => WorkflowScheduler
  maxRounds?: number
  maxPending?: number
  now?: () => number
}

/** Serializes event-triggered workflow rounds without an instance-specific issue coordinator. */
export class WorkflowQueue {
  constructor(private readonly options: WorkflowQueueOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }

  async enqueue(event: QueuedActivation): Promise<{ accepted: boolean; state: QueueState }> {
    if (
      !/^[a-z][a-z0-9-]*:[a-f0-9]{64}$/.test(event.key) ||
      event.trigger.key !== event.key ||
      !event.trigger.id ||
      !event.workflowId
    )
      throw new Error("Invalid keyed workflow activation")
    const result = await this.options.store.enqueue(event, this.options.maxPending ?? 100)
    if (result.accepted) await this.options.store.schedule(this.now())
    return result
  }

  status(): Promise<QueueState> {
    return this.options.store.read()
  }

  async alarm(): Promise<void> {
    const state = await this.status()
    if (state.blocked) return
    if (!state.active) {
      const next = state.pending[0]
      if (!next) return
      if (state.rounds >= (this.options.maxRounds ?? 1_000)) {
        state.blocked = "Workflow revision ceiling reached"
        state.revision++
        await this.options.store.compareAndWrite(state.revision - 1, state)
        return
      }
      state.active = next
      state.pending.shift()
      state.revision++
      if (!(await this.options.store.compareAndWrite(state.revision - 1, state))) {
        await this.options.store.schedule(this.now())
        return
      }
    }
    // Once claimed, the active key stays durable even if start/alarm is interrupted.
    const key = state.active
    if (!key) return
    const event = await this.options.store.event(key)
    if (!event) throw new Error("Claimed workflow event is missing")
    const scheduler = this.options.scheduler(key)
    let run = await scheduler.status()
    if (!run) {
      await scheduler.start(event.workflowId, event.input, event.trigger)
      return
    }
    if (run.status === "running") await scheduler.alarm()
    run = await scheduler.status()
    if (!run || run.status === "running") return
    const latest = await this.status()
    if (latest.active !== key || latest.blocked) return
    latest.active = undefined
    latest.rounds++
    if (run.status !== "completed") latest.blocked = `Workflow ${run.status}; inspect ${key}`
    latest.revision++
    if (!(await this.options.store.compareAndWrite(latest.revision - 1, latest))) {
      await this.options.store.schedule(this.now())
      return
    }
    if (latest.pending.length && !latest.blocked) await this.options.store.schedule(this.now())
  }
}
