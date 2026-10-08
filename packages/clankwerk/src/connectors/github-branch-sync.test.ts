import { expect, test } from "vitest"
import { Octokit } from "@octokit/rest"
import { syncDraftBranch as syncScoped } from "./github-branch-sync.js"

const policy = { owner: "leostera", repo: "r4", base: "main", branchForIssue: (issue: number) => `r4/issue-${issue}` }
const syncDraftBranch = (draft: { branch: string; commit: string; number: number; url: string }, client: Octokit) =>
  syncScoped(4, draft, client, policy)

const main = "a".repeat(40)
const old = "b".repeat(40)
const merged = "c".repeat(40)
const draft = { branch: "r4/issue-4", commit: old, number: 5, url: "https://github.com/leostera/r4/pull/5" }

function client(conflicts = false) {
  let head = old
  let updates = 0
  const api = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(url).pathname.replace("/repos/leostera/r4", ""))
        if (path === "/git/ref/heads/main") return Response.json({ object: { sha: main } })
        if (path === `/git/commits/${merged}`) return Response.json({ parents: [{ sha: old }, { sha: main }] })
        if (path === "/pulls/5" && init?.method !== "PUT")
          return Response.json({
            state: "open",
            draft: true,
            head: { sha: head, ref: draft.branch, repo: { full_name: "leostera/r4" } },
            base: { ref: "main" },
            mergeable: !conflicts,
          })
        if (path === "/pulls/5/update-branch") {
          updates++
          if (conflicts) return Response.json({ message: "Merge conflict" }, { status: 422 })
          head = merged
          return Response.json({ message: "Updating pull request branch" }, { status: 202 })
        }
        if (path.startsWith("/compare/"))
          return Response.json({ status: path.endsWith(`...${merged}`) ? "ahead" : "diverged" })
        throw new Error(`Unexpected GitHub path ${path}`)
      },
    },
  })
  return { api, updates: () => updates }
}

test("clean stale branch is synced with expected-head update and retry adopts the merge", async () => {
  const { api, updates } = client()
  const result = await syncDraftBranch(draft, api)
  expect(result).toEqual({ kind: "updated", main, pull: { ...draft, commit: merged } })
  expect((await syncDraftBranch(draft, api)).pull.commit).toBe(merged)
  expect(updates()).toBe(1)
})

test("verified conflict is returned for Coder, never force-pushed", async () => {
  const { api, updates } = client(true)
  const result = await syncDraftBranch(draft, api)
  expect(result.kind).toBe("conflict")
  expect(result.pull.commit).toBe(old)
  expect(updates()).toBe(1)
})
