import { expect, test } from "vitest"
import { Effect } from "effect"
import { Id } from "../graph/id.js"
import { Task } from "../graph/task.js"
import { WorkflowScheduler, type RunRecord, type RunStore } from "./scheduler.js"
import { invokeRecordedAgent } from "./lineage.js"

function receiptFixture() {
  let run: RunRecord = {
    id: "run-1",
    workflowId: "research",
    definitionHash: "sha256:test",
    revision: 0,
    status: "running",
    steps: [{ id: "step", status: "running", attempts: 1, leaseToken: "lease" }],
    events: [],
  }
  const store: RunStore = {
    read: async () => structuredClone(run),
    createIfAbsent: async () => structuredClone(run),
    compareAndWrite: async (revision, value) => {
      if (run.revision !== revision) return false
      run = structuredClone(value)
      return true
    },
    schedule: async () => {},
  }
  const input = {
    store,
    runId: "run-1",
    stepId: "step",
    leaseToken: "lease",
    agentId: "researcher",
    instanceName: "alice",
    request: new Request("https://worker.test/agents/researcher/alice"),
    authorize: (agent: string, name: string, request: Request) => {
      if (agent !== "researcher" || name !== "alice" || new URL(request.url).pathname !== "/agents/researcher/alice")
        throw new Error("Agent request path mismatch")
    },
  }
  return { store, input }
}

test("agent receipts distinguish failed HTTP and transport responses without duplicate audit events", async () => {
  const first = receiptFixture()
  await invokeRecordedAgent({ ...first.input, fetchAgent: async () => new Response("bad", { status: 503 }) })
  expect((await first.store.read())?.agentCalls?.[0]).toMatchObject({ status: "failed", httpStatus: 503 })
  const second = receiptFixture()
  await expect(
    invokeRecordedAgent({
      ...second.input,
      fetchAgent: async () => {
        throw new Error("offline")
      },
    }),
  ).rejects.toThrow("offline")
  expect((await second.store.read())?.events.map((event) => event.type)).toEqual(["agent.started", "agent.failed"])
})

test("unknown agents and mismatched paths are rejected before recording a call", async () => {
  const fixture = receiptFixture()
  let fetched = false
  await expect(
    invokeRecordedAgent({
      ...fixture.input,
      agentId: "unknown",
      fetchAgent: async () => {
        fetched = true
        return new Response()
      },
    }),
  ).rejects.toThrow("path mismatch")
  await expect(
    invokeRecordedAgent({
      ...fixture.input,
      request: new Request("https://worker.test/other"),
      fetchAgent: async () => {
        fetched = true
        return new Response()
      },
    }),
  ).rejects.toThrow("path mismatch")
  expect(fetched).toBe(false)
  expect((await fixture.store.read())?.agentCalls).toBeUndefined()
})

test("agent calls are recorded before dispatch and fenced to the active workflow step", async () => {
  let run: RunRecord | undefined
  let fetched = 0
  const store: RunStore = {
    read: async () => run && structuredClone(run),
    createIfAbsent: async (value) => structuredClone((run ??= structuredClone(value))),
    compareAndWrite: async (revision, value) => {
      if (run?.revision !== revision) return false
      run = structuredClone(value)
      return true
    },
    schedule: async () => {},
  }
  const task = Task.fn({
    id: Id.node("query-researcher"),
    run: (_: unknown, context) =>
      Effect.tryPromise(async () => {
        const response = await context?.callAgent?.(
          "researcher",
          "alice",
          new Request("https://worker.test/agents/researcher/alice"),
        )
        return response?.status
      }),
  })
  const scheduler = new WorkflowScheduler({
    id: "test-1",
    store,
    workflows: { research: { id: "research", graph: task } },
    context: (active, step) => ({
      callAgent: (agentId, instanceName, request) =>
        invokeRecordedAgent({
          store,
          runId: active.id,
          stepId: step.id,
          leaseToken: step.leaseToken!,
          agentId,
          instanceName,
          request,
          authorize: (agent, instance, request) => {
            if (
              agent !== "researcher" ||
              instance !== "alice" ||
              new URL(request.url).pathname !== "/agents/researcher/alice"
            )
              throw new Error("Invalid agent call")
          },
          fetchAgent: async () => {
            fetched++
            expect((await store.read())?.agentCalls?.[0]?.status).toBe("started")
            return new Response("ok", { status: 200 })
          },
        }),
    }),
  })
  await scheduler.start("research", {})
  await scheduler.alarm()
  await scheduler.alarm()
  expect(fetched).toBe(1)
  expect((await scheduler.status())?.agentCalls?.[0]).toMatchObject({
    agentId: "researcher",
    instanceName: "alice",
    status: "completed",
    httpStatus: 200,
  })
  expect((await scheduler.status())?.events.map((event) => event.type)).toEqual([
    "run.started",
    "step.started",
    "agent.started",
    "agent.completed",
    "step.completed",
    "run.completed",
  ])
})
