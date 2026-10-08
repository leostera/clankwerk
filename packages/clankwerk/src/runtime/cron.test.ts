import { expect, test } from "vitest"
import { Effect } from "effect"
import { Id } from "../graph/id.js"
import { Task } from "../graph/task.js"
import { Triggers } from "../graph/trigger.js"
import { WorkflowScheduler, type RunRecord, type RunStore } from "./scheduler.js"
import { dispatchCron } from "./cron.js"

test("scheduled ticks activate declared cron nodes and deduplicate replays within a minute", async () => {
  const cron = Triggers.cron<{ kind: string }>({
    id: Id.trigger("base-check"),
    schedule: "*/5 * * * *",
    value: { kind: "base-check" },
  })
  const task = Task.fn({ id: Id.node("check"), run: (value: { kind: string }) => Effect.succeed(value.kind) })
  const workflow = { id: "base-check", graph: cron.then(task) }
  const events: unknown[] = []
  const activate = async (event: (typeof events)[number]) => {
    events.push(event)
  }
  const at = Date.UTC(2026, 9, 7, 18, 50, 1)
  const [event] = await dispatchCron("*/5 * * * *", at, [workflow], activate)
  expect(event).toMatchObject({ value: { kind: "base-check" }, partition: event!.key })
  const [replayed] = await dispatchCron("*/5 * * * *", at + 40_000, [workflow], activate)
  expect(replayed!.key).toBe(event!.key)
  expect(await dispatchCron("0 0 * * *", at, [workflow], activate)).toEqual([])
  let run: RunRecord | undefined
  const store: RunStore = {
    read: async () => (run ? structuredClone(run) : undefined),
    createIfAbsent: async (candidate) => {
      run ??= structuredClone(candidate)
      return structuredClone(run)
    },
    compareAndWrite: async (revision, value) => {
      if (run?.revision !== revision) return false
      run = structuredClone(value)
      return true
    },
    schedule: async () => {},
  }
  const scheduler = new WorkflowScheduler({ id: event!.key, store, workflows: { "base-check": workflow } })
  await scheduler.start("base-check", null, { id: event!.triggerId, key: event!.key, value: event!.value })
  await scheduler.alarm()
  await scheduler.alarm()
  expect((await scheduler.status())?.steps.find((step) => step.id === task.id)?.output).toBe("base-check")
})
