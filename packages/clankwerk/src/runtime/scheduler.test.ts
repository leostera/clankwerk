import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Id } from "../graph/id.js"
import { Task } from "../graph/task.js"
import { Triggers } from "../graph/trigger.js"
import { Workflow } from "../graph/workflow.js"
import { createWorkflowManifest } from "../graph/manifest.js"
import { WorkflowScheduler, type RunRecord, type RunStore } from "./scheduler.js"
import { githubWorkflowCapability } from "../connectors/github-workflow-context.js"

function memoryStore() {
  let state: RunRecord | undefined
  const alarms: number[] = []
  const store: RunStore = {
    read: async () => state && structuredClone(state),
    createIfAbsent: async (run) => structuredClone((state ??= structuredClone(run))),
    compareAndWrite: async (revision, run) => {
      if (!state || state.revision !== revision || run.revision !== revision + 1) return false
      state = structuredClone(run)
      return true
    },
    schedule: async (at) => {
      alarms.push(at)
    },
  }
  return { store, alarms }
}

const triggerId = Id.trigger("pull-request")
const trigger = Triggers.webhook<{ number: number; head: string }>({ id: triggerId })

describe("Clankwerk workflow scheduler", () => {
  it("injects scoped Octokit into a trusted workflow step without persisting the client or token", async () => {
    const capability = githubWorkflowCapability({
      repository: { id: 11, fullName: "team/first", installationId: 8 },
      workflowId: "repository-lookup",
      policy: async () => ({
        id: 11,
        fullName: "team/first",
        installationId: 8,
        base: "main",
        revision: 1,
        enabled: true,
        workflows: ["repository-lookup"],
        minimumIssue: 1,
      }),
      allowedPermissions: { contents: "read" },
      app: { clientId: "test-client", appId: 42, privateKey: "private" },
      issueToken: async () => ({
        token: "ghs_only-for-test",
        repositoryId: 11,
        installationId: 8,
        bot: "bot[bot]",
        expiresAt: Date.now() + 60_000,
      }),
    })
    const task = Task.fn({
      id: Id.node("lookup-repository"),
      run: (_: unknown, context) =>
        Effect.tryPromise(() =>
          context!.github!.withOctokit({ contents: "read" }, async (_client, scope) => scope.owner + "/" + scope.repo),
        ),
    })
    const workflow = { id: "repository-lookup", graph: task }
    const { store } = memoryStore()
    const scheduler = new WorkflowScheduler({
      id: "repo:11:lookup",
      store,
      workflows: { [workflow.id]: workflow },
      context: () => ({ github: capability }),
    })
    await scheduler.start(workflow.id, null)
    await scheduler.alarm()
    await scheduler.alarm()
    expect((await scheduler.status())?.steps[0]?.output).toBe("team/first")
    expect(JSON.stringify(await scheduler.status())).not.toContain("ghs_only-for-test")
  })

  it("rejects a non-executable map dependency before creating a stalled durable run", async () => {
    const mapped = trigger.map((event) => ({ ...event, head: event.head.toUpperCase() }))
    const graph = mapped.then(
      Task.fn({ id: Id.node("record-mapped-head"), run: (event) => Effect.succeed(event.head) }),
    )
    const { store } = memoryStore()
    const scheduler = new WorkflowScheduler({
      id: "mapped-head",
      store,
      workflows: { mapped: { id: "mapped", graph } },
    })
    await expect(
      scheduler.start("mapped", null, {
        id: triggerId,
        key: "mapped-head",
        value: { number: 1, head: "abc" },
      }),
    ).rejects.toThrow("non-executable dependency")
    expect(await scheduler.status()).toBeUndefined()
  })

  it("runs a triggered workflow durably using the trigger value rather than the untrusted start input", async () => {
    const task = Task.fn({
      id: Id.node("record-head"),
      run: (event: { number: number; head: string }, context) =>
        Effect.succeed({
          issue: event.number,
          commit: event.head,
          run: context?.runId,
        }),
    })
    const workflow = { id: "code-review", graph: trigger.then(task) }
    const { store, alarms } = memoryStore()
    const scheduler = new WorkflowScheduler({
      id: "review:5:sha1",
      store,
      workflows: { [workflow.id]: workflow },
      now: () => 1234,
    })
    const activation = { id: triggerId, key: "review:5:sha1", value: { number: 5, head: "sha1" } }
    const started = await scheduler.start(workflow.id, { number: 999, head: "forged" }, activation)
    expect(started.steps).toHaveLength(2)
    expect(
      await scheduler.start(workflow.id, {}, { ...activation, value: { number: 5, head: "other-payload" } }),
    ).toEqual(started)
    await scheduler.alarm() // trigger
    await scheduler.alarm() // task
    await scheduler.alarm() // terminal state
    const finished = await scheduler.status()
    expect(finished?.status).toBe("completed")
    expect(finished?.steps[1]?.output).toEqual({ issue: 5, commit: "sha1", run: "review:5:sha1" })
    expect(alarms).toHaveLength(5) // initial + watchdog and completion for each step
    await expect(
      scheduler.start(workflow.id, {}, { id: triggerId, key: "review:5:sha2", value: { number: 5, head: "sha2" } }),
    ).rejects.toThrow("different workflow or trigger")
  })

  it("runs three static branches and joins their named outputs only after all complete", async () => {
    const received = Task.fn({ id: Id.node("snapshot"), run: (n: number) => Effect.succeed(n) })
    const graph = Triggers.manual<number>({ id: Id.trigger("review-static") })
      .then(received)
      .fanout({
        usability: Task.fn({ id: Id.node("review-usability"), run: (n: number) => Effect.succeed(n + 1) }),
        correctness: Task.fn({ id: Id.node("review-correctness"), run: (n: number) => Effect.succeed(n + 2) }),
        performance: Task.fn({ id: Id.node("review-performance"), run: (n: number) => Effect.succeed(n + 3) }),
      })
      .then(
        Task.fn({
          id: Id.node("review-join"),
          run: (results: { usability: number; correctness: number; performance: number }) => Effect.succeed(results),
        }),
      )
    const workflow = { id: "review-static", graph }
    const { store } = memoryStore()
    const scheduler = new WorkflowScheduler({ id: "review:static", store, workflows: { [workflow.id]: workflow } })
    await scheduler.start(workflow.id, null, { id: graph.triggers[0]!.id, key: "review:static", value: 4 })
    for (let i = 0; i < 9; i++) await scheduler.alarm()
    const result = await scheduler.status()
    expect(result?.status).toBe("completed")
    expect(result?.steps.find((step) => step.id === Id.node("review-join"))?.output).toEqual({
      usability: 5,
      correctness: 6,
      performance: 7,
    })
  })

  it("executes a choice of GitHub triggers as one manifested selector step", async () => {
    const issue = Triggers.webhook<{ source: "issue"; number: number }>({ id: Id.trigger("issue") })
    const feedback = Triggers.webhook<{ source: "review"; number: number }>({ id: Id.trigger("review") })
    const record = Task.fn({
      id: Id.node("record"),
      run: (event: { source: "issue" | "review"; number: number }) => Effect.succeed(`${event.source}:${event.number}`),
    })
    const workflow = {
      id: "contribute",
      graph: Workflow.oneOf<{ source: "issue" | "review"; number: number }>([issue, feedback]).then(record),
    }
    const manifest = await createWorkflowManifest({
      workflowId: Id.workflow("contribute"),
      tasks: workflow.graph.definitions,
      triggers: workflow.graph.triggers,
    })
    expect(manifest.edges.filter((edge) => edge.kind === "trigger").map((edge) => edge.to)).toEqual([
      Id.node("oneOf"),
      Id.node("oneOf"),
    ])
    const { store } = memoryStore()
    const scheduler = new WorkflowScheduler({ id: "issue:4", store, workflows: { contribute: workflow } })
    await scheduler.start(
      "contribute",
      {},
      { id: feedback.triggers[0]!.id, key: "review:4:1", value: { source: "review", number: 4 } },
    )
    await scheduler.alarm()
    await scheduler.alarm()
    expect((await scheduler.status())?.steps.find((step) => step.id === record.id)?.output).toBe("review:4")
  })

  it("passes a manual activation's value through a real trigger node", async () => {
    const manual = Triggers.manual<{ hostname: string }>({ id: Id.trigger("health-check") })
    const check = Task.fn({
      id: Id.node("check-host"),
      run: (input: { hostname: string }) => Effect.succeed(input.hostname),
    })
    const workflow = { id: "health", graph: manual.then(check) }
    const { store } = memoryStore()
    const scheduler = new WorkflowScheduler({ id: "health:1", store, workflows: { health: workflow } })
    await scheduler.start(
      "health",
      { hostname: "wrong.example" },
      { id: manual.triggers[0]!.id, key: "health:1", value: { hostname: "right.example" } },
    )
    await scheduler.alarm()
    await scheduler.alarm()
    expect((await scheduler.status())?.steps.find((step) => step.id === check.id)?.output).toBe("right.example")
  })

  it("retries an interrupted or failed step, preserves completed steps, and stops at its limit", async () => {
    let attempts = 0
    const task = Task.fn({
      id: Id.node("publish"),
      retry: { maxAttempts: 2, backoffMs: 500 },
      run: (_: unknown) =>
        Effect.sync(() => {
          attempts++
          if (attempts === 1) throw new Error("private details should not persist")
          return { published: true }
        }),
    })
    const workflow = { id: "contribute", graph: task }
    const { store, alarms } = memoryStore()
    let now = 1000
    const scheduler = new WorkflowScheduler({
      id: "issue:4",
      store,
      workflows: { contribute: workflow },
      now: () => now,
    })
    await scheduler.start(workflow.id, { issue: 4 })
    await scheduler.alarm()
    expect((await scheduler.status())?.steps[0]).toMatchObject({
      status: "ready",
      attempts: 1,
      error: "NodeExecutionError",
    })
    expect(alarms.at(-1)).toBe(1500)
    await scheduler.alarm() // an early alarm cannot bypass backoff
    expect(attempts).toBe(1)
    now = 1500
    await scheduler.alarm()
    await scheduler.alarm()
    expect((await scheduler.status())?.status).toBe("completed")
    expect(attempts).toBe(2)
  })

  it("does not repeat a live step or accept the late result of an expired lease", async () => {
    let now = 1_000
    let releaseFirst: ((value: string) => void) | undefined
    let calls = 0
    const task = Task.fn({
      id: Id.node("slow-publish"),
      retry: { maxAttempts: 3, backoffMs: 1 },
      run: () =>
        Effect.tryPromise(() => {
          calls++
          return calls === 1
            ? new Promise<string>((resolve) => {
                releaseFirst = resolve
              })
            : Promise.resolve("second")
        }),
    })
    const { store } = memoryStore()
    const scheduler = new WorkflowScheduler({
      id: "issue:4",
      store,
      workflows: { contribute: { id: "contribute", graph: task } },
      now: () => now,
      leaseMs: 50,
    })
    await scheduler.start("contribute", {})
    const interrupted = scheduler.alarm()
    for (let i = 0; !releaseFirst && i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(releaseFirst).toBeTypeOf("function")
    await scheduler.alarm() // an unrelated wake-up must not repeat the live call
    expect(calls).toBe(1)
    now += 51
    await scheduler.alarm() // expired attempt is retried with a new fencing token
    expect(calls).toBe(2)
    expect((await scheduler.status())?.steps[0]?.output).toBe("second")
    releaseFirst!("late-first-result")
    await interrupted
    expect((await scheduler.status())?.steps[0]?.output).toBe("second")
    await scheduler.alarm()
    expect((await scheduler.status())?.status).toBe("completed")
  })

  it("fails closed on incompatible manifests before executing a task", async () => {
    let called = 0
    const make = (version: string) => ({
      id: "contribute",
      graph: Task.fn({
        id: Id.node("edit"),
        version,
        run: () =>
          Effect.sync(() => {
            called++
            return "done"
          }),
      }),
    })
    const { store } = memoryStore()
    await new WorkflowScheduler({ id: "issue:4", store, workflows: { contribute: make("1") } }).start("contribute", {})
    const deployed = new WorkflowScheduler({ id: "issue:4", store, workflows: { contribute: make("2") } })
    await deployed.alarm()
    expect((await deployed.status())?.status).toBe("incompatible")
    expect(called).toBe(0)
  })
})
