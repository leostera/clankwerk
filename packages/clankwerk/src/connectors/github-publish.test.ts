import { expect, test } from "vitest"
import { Octokit } from "@octokit/rest"
import {
  publishDraft as publishScoped,
  reviseDraft as reviseScoped,
  validateDraft as validateScoped,
  type DraftChange,
} from "./github-publish.js"

const policy = { owner: "leostera", repo: "r4", base: "main", branchForIssue: (issue: number) => `r4/issue-${issue}` }
const publishDraft = (change: DraftChange, client: Octokit) => publishScoped(change, client, policy)
const reviseDraft = (
  change: DraftChange,
  previous: { branch: string; commit: string; number: number; url: string },
  client: Octokit,
  priorBase?: string,
) => reviseScoped(change, previous, client, policy, priorBase)
const validateDraft = (change: DraftChange) => validateScoped(change, policy)

const base = "a".repeat(40)
const tree = "b".repeat(40)
const blob = "c".repeat(40)
const commit = "d".repeat(40)
const input: DraftChange = {
  issue: 2,
  base,
  title: "Document issue approval flow",
  files: [{ path: "docs/issue-flow.md", content: "No automatic merge.\n" }],
}

test("Octokit publishes only an issue branch and draft PR from the exact base", async () => {
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = []
  const octokit = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(url).pathname.replace("/repos/leostera/r4", ""))
        const method = init?.method ?? "GET"
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
        requests.push({ path, method, body })
        expect(new Headers(init?.headers).get("authorization")).toBeTruthy()
        if (path === "/git/ref/heads/main") return Response.json({ object: { sha: base } })
        if (path === "/git/ref/heads/r4/issue-2") return Response.json({ message: "Not Found" }, { status: 404 })
        if (path === `/git/commits/${base}`) return Response.json({ tree: { sha: tree } })
        if (path === "/git/blobs") return Response.json({ sha: blob }, { status: 201 })
        if (path === "/git/trees") return Response.json({ sha: tree }, { status: 201 })
        if (path === "/git/commits") return Response.json({ sha: commit }, { status: 201 })
        if (path === "/git/refs") return Response.json({ ref: "refs/heads/r4/issue-2" }, { status: 201 })
        if (path === "/pulls" && method === "GET") return Response.json([])
        if (path === "/pulls" && method === "POST")
          return Response.json({ number: 3, html_url: "https://github.com/leostera/r4/pull/3" }, { status: 201 })
        throw new Error(`Unexpected GitHub path ${path}`)
      },
    },
  })
  const result = await publishDraft(input, octokit)
  expect(result).toEqual({ branch: "r4/issue-2", commit, url: "https://github.com/leostera/r4/pull/3", number: 3 })
  expect(requests.find((x) => x.path === "/git/refs")?.body?.ref).toBe("refs/heads/r4/issue-2")
  expect(requests.find((x) => x.path === "/pulls" && x.method === "POST")?.body?.draft).toBe(true)
  expect(requests.find((x) => x.path === "/git/trees")?.body?.base_tree).toBe(tree)
})

test("retries after branch creation without replacing the existing commit or duplicating the PR", async () => {
  let branchExists = false
  let pullExists = false
  let commitWrites = 0
  let refWrites = 0
  let pullWrites = 0
  const octokit = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(url).pathname.replace("/repos/leostera/r4", ""))
        const method = init?.method ?? "GET"
        if (path === "/git/ref/heads/main") return Response.json({ object: { sha: base } })
        if (path === "/git/ref/heads/r4/issue-2")
          return branchExists
            ? Response.json({ object: { sha: commit } })
            : Response.json({ message: "Not Found" }, { status: 404 })
        if (path === `/git/commits/${base}`) return Response.json({ tree: { sha: tree } })
        if (path === `/git/commits/${commit}`)
          return Response.json({ tree: { sha: tree }, message: `Work on #2: ${input.title}`, parents: [{ sha: base }] })
        if (path === "/git/blobs") return Response.json({ sha: blob }, { status: 201 })
        if (path === "/git/trees") return Response.json({ sha: tree }, { status: 201 })
        if (path === "/git/commits" && method === "POST") {
          commitWrites++
          return Response.json({ sha: commit }, { status: 201 })
        }
        if (path === "/git/refs" && method === "POST") {
          branchExists = true
          refWrites++
          return Response.json({}, { status: 201 })
        }
        if (path === "/pulls" && method === "GET")
          return pullExists
            ? Response.json([
                {
                  head: { sha: commit },
                  base: { ref: "main" },
                  number: 3,
                  html_url: "https://github.com/leostera/r4/pull/3",
                },
              ])
            : Response.json([])
        if (path === "/pulls" && method === "POST") {
          pullWrites++
          pullExists = true
          return Response.json({ number: 3, html_url: "https://github.com/leostera/r4/pull/3" }, { status: 201 })
        }
        throw new Error(`Unexpected GitHub path ${path}`)
      },
    },
  })
  const first = await publishDraft(input, octokit)
  const retry = await publishDraft(input, octokit)
  expect(retry).toEqual(first)
  expect([commitWrites, refWrites, pullWrites]).toEqual([1, 1, 1])
})

test("revision advances only its expected draft head and can recover a lost acknowledgement", async () => {
  const next = "e".repeat(40)
  const nextTree = "f".repeat(40)
  const previous = { branch: "r4/issue-2", commit, number: 3, url: "https://github.com/leostera/r4/pull/3" }
  let head = commit
  let writes = 0
  const octokit = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(url).pathname.replace("/repos/leostera/r4", ""))
        if (path === "/git/ref/heads/main") return Response.json({ object: { sha: base } })
        if (path === "/pulls/3")
          return Response.json({
            state: "open",
            draft: true,
            base: { ref: "main" },
            head: { repo: { full_name: "leostera/r4" }, ref: "r4/issue-2", sha: head },
          })
        if (path === "/git/ref/heads/r4/issue-2") return Response.json({ object: { sha: head } })
        if (path === `/git/commits/${base}`) return Response.json({ tree: { sha: tree } })
        if (path === `/git/commits/${commit}`) return Response.json({ tree: { sha: tree } })
        if (path === `/git/commits/${next}`)
          return Response.json({
            tree: { sha: nextTree },
            parents: [{ sha: commit }],
            message: `Revise #2: ${input.title}`,
          })
        if (path === "/git/blobs") return Response.json({ sha: blob }, { status: 201 })
        if (path === "/git/trees") return Response.json({ sha: nextTree }, { status: 201 })
        if (path === "/git/commits" && init?.method === "POST") {
          writes++
          return Response.json({ sha: next }, { status: 201 })
        }
        if (path === "/git/refs/heads/r4/issue-2" && init?.method === "PATCH") {
          head = next
          return Response.json({ object: { sha: head } })
        }
        throw new Error(`Unexpected path ${path}`)
      },
    },
  })
  expect((await reviseDraft(input, previous, octokit)).commit).toBe(next)
  expect((await reviseDraft(input, previous, octokit)).commit).toBe(next)
  expect(writes).toBe(1)
})

test("conflicted base sync publishes a two-parent merge commit, without force-push", async () => {
  const priorBase = "9".repeat(40)
  const nextTree = "f".repeat(40)
  let commitParents: unknown
  let force: unknown
  const previous = { branch: "r4/issue-2", commit, number: 3, url: "https://github.com/leostera/r4/pull/3" }
  const client = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async (url: string, init?: RequestInit) => {
        const path = decodeURIComponent(new URL(url).pathname.replace("/repos/leostera/r4", ""))
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        if (path === "/git/ref/heads/main") return Response.json({ object: { sha: base } })
        if (path === "/pulls/3")
          return Response.json({
            state: "open",
            draft: true,
            base: { ref: "main" },
            head: { repo: { full_name: "leostera/r4" }, ref: previous.branch, sha: commit },
          })
        if (path === "/git/ref/heads/r4/issue-2") return Response.json({ object: { sha: commit } })
        if (path === `/git/commits/${base}` || path === `/git/commits/${commit}`)
          return Response.json({ tree: { sha: tree } })
        if (path === "/git/blobs") return Response.json({ sha: blob }, { status: 201 })
        if (path === "/git/trees") return Response.json({ sha: nextTree }, { status: 201 })
        if (path === "/git/commits" && init?.method === "POST") {
          commitParents = body.parents
          return Response.json({ sha: "e".repeat(40) }, { status: 201 })
        }
        if (path === "/git/refs/heads/r4/issue-2" && init?.method === "PATCH") {
          force = body.force
          return Response.json({ object: { sha: "e".repeat(40) } })
        }
        throw new Error(`Unexpected path ${path}`)
      },
    },
  })
  await reviseDraft(input, previous, client, priorBase)
  expect(commitParents).toEqual([commit, base])
  expect(force).toBe(false)
})

test("rejects secrets, workflows, path traversal and oversized outputs", () => {
  for (const path of [".env", "config/.env.local", ".github/workflows/ci.yml", "../README.md", "x/.git/config"])
    expect(() => validateDraft({ ...input, files: [{ path, content: "hello" }] })).toThrow()
  expect(() => validateDraft({ ...input, files: [{ path: "docs/giant.md", content: "x".repeat(100_001) }] })).toThrow()
  expect(() => validateDraft({ ...input, issue: 0 })).toThrow()
})

test("main moving fails before any write call", async () => {
  let calls = 0
  const octokit = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async () => {
        calls++
        return Response.json({ object: { sha: "f".repeat(40) } })
      },
    },
  })
  await expect(publishDraft(input, octokit)).rejects.toThrow("Main moved")
  expect(calls).toBe(1)
})
