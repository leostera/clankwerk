import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Id } from "../graph/id.js"
import { Task } from "../graph/task.js"
import { WorkflowScheduler, type RunRecord, type RunStore } from "../runtime/scheduler.js"
import { claimGitHubDelivery, type GitHubClaimStorage } from "./github-delivery-claim.js"
import { dispatchGitHubApp, githubAppTriggers } from "./github-app-source.js"
import type { SignedGitHubEvent } from "./github-app-event.js"
import {
  disableRepository,
  enableRepository,
  type RepositoryPolicy,
  type RepositoryPolicyStore,
} from "./github-repository-policy.js"

const path = "/hooks/github"
const secret = "app-test-secret"
const source = githubAppTriggers(path)
const issue = {
  id: "triage",
  graph: source.issue.then(
    Task.fn({
      id: Id.node("record-issue"),
      run: (input: SignedGitHubEvent & { kind: "issue" }) =>
        Effect.succeed(`${input.repository.id}:issue:${input.number}`),
    }),
  ),
}
const pull = {
  id: "review",
  graph: source.pull.then(
    Task.fn({
      id: Id.node("record-pr"),
      run: (input: SignedGitHubEvent & { kind: "pull" }) =>
        Effect.succeed(`${input.repository.id}:pr:${input.number}:${input.head}`),
    }),
  ),
}
function repositoryActor() {
  const records = new Map<string, unknown>()
  const policy: RepositoryPolicyStore = {
    read: async () => records.get("repository-policy") as RepositoryPolicy | undefined,
    compareAndWrite: async (revision, next) => {
      if (((records.get("repository-policy") as RepositoryPolicy | undefined)?.revision ?? 0) !== revision) return false
      records.set("repository-policy", next)
      return true
    },
  }
  const claims: GitHubClaimStorage = {
    async transaction<T>(
      fn: (tx: {
        get<V>(key: string): Promise<V | undefined>
        put(key: string, value: unknown): Promise<void>
      }) => Promise<T>,
    ) {
      const copy = new Map(records)
      const result = await fn({
        get: async <V>(key: string) => copy.get(key) as V | undefined,
        put: async (key, value) => {
          copy.set(key, value)
        },
      })
      records.clear()
      for (const [key, value] of copy) records.set(key, value)
      return result
    },
  }
  return { policy, claims }
}
function schedulerStore(): RunStore {
  let run: RunRecord | undefined
  return {
    read: async () => run && structuredClone(run),
    createIfAbsent: async (candidate) => structuredClone((run ??= structuredClone(candidate))),
    compareAndWrite: async (revision, candidate) => {
      if (!run || run.revision !== revision || candidate.revision !== revision + 1) return false
      run = structuredClone(candidate)
      return true
    },
    schedule: async () => {},
  }
}
let delivery = 0
async function signed(
  repositoryId: number,
  repoName: string,
  event: "issues" | "pull_request",
  head = "a".repeat(40),
  reuse?: string,
) {
  const id = reuse ?? `00000000-0000-4000-8000-${String(++delivery).padStart(12, "0")}`
  const repository = { id: repositoryId, full_name: `team/${repoName}`, owner: { login: "team" }, name: repoName }
  const body = JSON.stringify({
    repository,
    installation: { id: 8 },
    action: event === "issues" ? "opened" : "synchronize",
    ...(event === "issues"
      ? {
          issue: {
            number: 1,
            title: "Request",
            body: "Body",
            user: { login: "author" },
            html_url: `https://github.com/team/${repoName}/issues/1`,
          },
        }
      : { pull_request: { number: 1, head: { sha: head }, html_url: `https://github.com/team/${repoName}/pull/1` } }),
  })
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  return new Request(`https://triggers.test${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": id,
      "x-hub-signature-256": `sha256=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    },
  })
}

describe("no-redeploy repository enablement with signed source and durable scheduler", () => {
  it("starts two independently scoped issues and an exact-head PR from the same graph definitions", async () => {
    const actors = new Map([
      [11, repositoryActor()],
      [12, repositoryActor()],
    ])
    const runs = new Map<string, WorkflowScheduler>()
    const config = {
      path,
      secret,
      workflows: { issue, pull },
      policy: async (id: number) => actors.get(id)?.policy.read(),
      installation: async (signed: { id: number; fullName: string }) => ({
        ...signed,
        installationId: 8,
        base: "main",
      }),
      activate: async (
        activation: { workflowId: string; triggerId: string; key: string; value: unknown },
        receipt: { id: string; digest: string },
      ) => {
        const value = activation.value as {
          repository: { id: number; fullName: string; installationId: number }
          number: number
          kind: string
        }
        const actor = actors.get(value.repository.id)!
        const claim = await claimGitHubDelivery(actor.claims, {
          repository: value.repository,
          issueNumber: value.kind === "issue" ? value.number : undefined,
          activation: { ...activation, partition: activation.key },
          delivery: receipt,
          runId: activation.key,
        })
        let scheduler = runs.get(claim.runId)
        if (!scheduler) {
          scheduler = new WorkflowScheduler({
            id: claim.runId,
            workflows: { triage: issue, review: pull },
            store: schedulerStore(),
          })
          runs.set(claim.runId, scheduler)
        }
        await scheduler.start(activation.workflowId, value, {
          id: activation.triggerId,
          key: activation.key,
          value,
          kind: "webhook",
        })
      },
    }
    await enableRepository(
      actors.get(11)!.policy,
      { id: 11, fullName: "team/first", installationId: 8, base: "main" },
      { workflows: ["triage", "review"] },
      0,
      ["triage", "review"],
    )
    const a = await dispatchGitHubApp(await signed(11, "first", "issues"), config)
    expect(a).toHaveLength(1)
    expect(runs.size).toBe(1)
    // No source/manifest/scheduler rebuild: only registry state changes to enable B.
    await enableRepository(
      actors.get(12)!.policy,
      { id: 12, fullName: "team/second", installationId: 8, base: "main" },
      { workflows: ["triage", "review"] },
      0,
      ["triage", "review"],
    )
    const b = await dispatchGitHubApp(await signed(12, "second", "issues"), config)
    expect(a[0]?.key).not.toBe(b[0]?.key)
    const p = await dispatchGitHubApp(await signed(12, "second", "pull_request"), config)
    expect(p).toHaveLength(1)
    for (const scheduler of runs.values()) for (let n = 0; n < 3; n++) await scheduler.alarm()
    expect((await runs.get(a[0]!.key)?.status())?.steps[1]?.output).toBe("11:issue:1")
    expect((await runs.get(b[0]!.key)?.status())?.steps[1]?.output).toBe("12:issue:1")
    expect((await runs.get(p[0]!.key)?.status())?.steps[1]?.output).toBe(`12:pr:1:${"a".repeat(40)}`)
    await dispatchGitHubApp(await signed(12, "second", "issues"), config)
    expect(runs.size).toBe(3) // A second signed delivery joins the same logical issue.
    await dispatchGitHubApp(await signed(12, "second", "pull_request", "b".repeat(40)), config)
    expect(runs.size).toBe(4) // A changed head receives a distinct run.
    await disableRepository(actors.get(12)!.policy, 1)
    expect(await dispatchGitHubApp(await signed(12, "second", "issues"), config)).toEqual([])
    expect(runs.size).toBe(4)
  })
})
