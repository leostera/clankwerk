import { expect, test, vi } from "vitest"
import type { Octokit } from "@octokit/rest"
import { checkConclusion, upsertCommitCheck, type GitHubCheckScope } from "./github-checks.js"

const head = "a".repeat(40)
const scope: GitHubCheckScope = {
  owner: "acme",
  repo: "project",
  base: "trunk",
  appId: 42,
  externalIdPrefix: "acme-project",
  namePrefix: "ACME",
}
const verdict = {
  verdict: "changes_requested" as const,
  summary: "Fix API",
  findings: [{ path: "README.md", line: 2, comment: "Update example" }],
}
function fake() {
  let sha = head
  let base = "trunk"
  const runs: { id: number; name: string; external_id: string; app: { id: number }; status: string }[] = []
  const create = vi.fn(async (args: Record<string, unknown>) => {
    const run = {
      id: runs.length + 1,
      name: args.name as string,
      external_id: args.external_id as string,
      app: { id: 42 },
      status: args.status as string,
    }
    runs.push(run)
    return { data: run }
  })
  const update = vi.fn(async (args: Record<string, unknown>) => {
    const run = runs.find((item) => item.id === args.check_run_id)!
    run.status = args.status as string
    return { data: run }
  })
  const client = {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: { state: "open", head: { sha }, base: { ref: base, repo: { full_name: "acme/project" } } },
        })),
      },
      checks: {
        listForRef: vi.fn(async () => ({ data: { total_count: runs.length, check_runs: runs } })),
        create,
        update,
      },
    },
  } as unknown as Octokit
  return {
    client,
    create,
    update,
    setHead: (value: string) => {
      sha = value
    },
    setBase: (value: string) => {
      base = value
    },
  }
}

test("three evidence outcomes have distinct, branch-protection-safe conclusions", () => {
  expect(checkConclusion("looks_good")).toBe("success")
  expect(checkConclusion("changes_requested")).toBe("failure")
  expect(checkConclusion("blocked")).toBe("action_required")
})

test("a scoped check is completed and reconciled without another write", async () => {
  const { client, create, update, setHead, setBase } = fake()
  const args = [client, scope, 12, head, "correctness"] as const
  expect(await upsertCommitCheck(...args)).toEqual({ id: 1, stale: false })
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    owner: "acme",
    repo: "project",
    head_sha: head,
    name: "ACME / correctness",
    external_id: `acme-project:pr-12:${head}:correctness:v1`,
    status: "in_progress",
  })
  expect(await upsertCommitCheck(...args, verdict)).toEqual({ id: 1, stale: false })
  expect(update.mock.calls[0]?.[0]).toMatchObject({ status: "completed", conclusion: "failure" })
  expect(await upsertCommitCheck(...args, verdict)).toEqual({ id: 1, stale: false })
  expect(create).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledTimes(1)
  setHead("b".repeat(40))
  expect(await upsertCommitCheck(...args, verdict)).toEqual({ stale: true })
  setHead(head)
  setBase("another")
  expect(await upsertCommitCheck(...args, verdict)).toEqual({ stale: true })
})

test("invalid repository or dimension cannot write a check", async () => {
  const { client, create } = fake()
  await expect(upsertCommitCheck(client, { ...scope, owner: ".." }, 1, head, "correctness", verdict)).rejects.toThrow(
    "Invalid",
  )
  await expect(upsertCommitCheck(client, scope, 1, head, "cor:rectness", verdict)).rejects.toThrow("Invalid")
  expect(create).not.toHaveBeenCalled()
})
