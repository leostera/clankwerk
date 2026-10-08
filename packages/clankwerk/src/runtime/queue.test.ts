import { expect, test } from "vitest"
import { Effect } from "effect"
import { Id } from "../graph/id.js"
import { Task } from "../graph/task.js"
import { Triggers } from "../graph/trigger.js"
import { WorkflowQueue, type QueueState, type QueuedActivation, type WorkflowQueueStore } from "./queue.js"
import { WorkflowScheduler, type RunRecord, type RunStore } from "./scheduler.js"

function fixture(maxRounds = 1_000) {
  let state: QueueState = { revision: 0, pending: [], rounds: 0 }
  const events = new Map<string, QueuedActivation>()
  const runs = new Map<string, RunRecord>()
  const outputs: number[] = []
  const store: WorkflowQueueStore = {
    read: async () => structuredClone(state),
    event: async (key) => events.get(key),
    enqueue: async (event, maximum) => {
      if (events.has(event.key)) return { accepted: false, state: structuredClone(state) }
      if (state.blocked || state.pending.length >= maximum) throw new Error("queue full")
      events.set(event.key, event)
      state.pending.push(event.key)
      state.revision++
      return { accepted: true, state: structuredClone(state) }
    },
    compareAndWrite: async (revision, next) => {
      if (state.revision !== revision || next.revision !== revision + 1) return false
      state = structuredClone(next)
      return true
    },
    schedule: async () => {},
  }
  const trigger = Triggers.webhook<{ number: number }>({ id: Id.trigger("issue-feedback") })
  const task = Task.fn({
    id: Id.node("revision"),
    run: (input: { number: number }) =>
      Effect.sync(() => {
        outputs.push(input.number)
        return { done: input.number }
      }),
  })
  const workflow = { id: "contribute", graph: trigger.then(task) }
  const queue = new WorkflowQueue({
    store,
    maxRounds,
    scheduler: (key) => {
      const runStore: RunStore = {
        read: async () => (runs.has(key) ? structuredClone(runs.get(key)!) : undefined),
        createIfAbsent: async (run) => {
          if (!runs.has(key)) runs.set(key, structuredClone(run))
          return structuredClone(runs.get(key)!)
        },
        compareAndWrite: async (revision, next) => {
          if (runs.get(key)?.revision !== revision) return false
          runs.set(key, structuredClone(next))
          return true
        },
        schedule: async () => {},
      }
      return new WorkflowScheduler({ id: key, workflows: { contribute: workflow }, store: runStore })
    },
  })
  const event = (digit: string, number: number): QueuedActivation => {
    const key = `contribute:${digit.repeat(64)}`
    return {
      key,
      workflowId: workflow.id,
      input: { number: 999 },
      trigger: { id: trigger.triggers[0]!.id, key, value: { number } },
    }
  }
  return { queue, runs, outputs, event }
}

test("per-issue workflow events are deduplicated and run sequentially, retaining separate run records", async () => {
  const { queue, runs, outputs, event } = fixture()
  const first = event("a", 4)
  const second = event("b", 5)
  expect((await queue.enqueue(first)).accepted).toBe(true)
  expect((await queue.enqueue(first)).accepted).toBe(false)
  expect((await queue.enqueue(second)).accepted).toBe(true)
  for (let i = 0; i < 8; i++) await queue.alarm()
  expect(outputs).toEqual([4, 5])
  expect(await queue.status()).toMatchObject({ rounds: 2, pending: [], active: undefined })
  expect([...runs.values()].map((run) => run.status)).toEqual(["completed", "completed"])
})

test("the queue blocks before starting another event after its configured revision ceiling", async () => {
  const { queue, outputs, event } = fixture(1)
  await queue.enqueue(event("a", 4))
  await queue.enqueue(event("b", 5))
  for (let i = 0; i < 8; i++) await queue.alarm()
  expect(outputs).toEqual([4])
  expect((await queue.status()).blocked).toMatch(/ceiling/)
  await expect(queue.enqueue(event("c", 6))).rejects.toThrow("queue full")
})
