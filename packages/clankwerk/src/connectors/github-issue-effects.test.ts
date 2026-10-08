import { Octokit } from "@octokit/rest"
import { describe, expect, it } from "vitest"
import {
  ensureIssueComment,
  ensureIssueLabel,
  readIssueLabels,
  type IssueCommentReceipt,
} from "./github-issue-effects.js"

const scope = { owner: "team", repo: "first" }
const args = { number: 1, title: "Needs a label", body: "Details" }
const receiptStore = () => {
  const state = new Map<string, IssueCommentReceipt>()
  return {
    get: async (key: string) => state.get(key),
    put: async (key: string, value: IssueCommentReceipt) => {
      state.set(key, value)
    },
    state,
  }
}
function mockClient(repo = "first") {
  const issueUrl = `https://github.com/team/${repo}/issues/1`
  let labels: string[] = []
  const comments: { id: number; html_url: string; body: string; user: { login: string } }[] = []
  let writes = 0
  const requests: { path: string; method: string }[] = []
  const client = new Octokit({
    auth: "fake-token",
    request: {
      fetch: async (input: string, init?: RequestInit) => {
        const parsed = new URL(input)
        const method = init?.method ?? "GET"
        const path = parsed.pathname
        requests.push({ path, method })
        if (!path.startsWith(`/repos/team/${repo}/`)) throw new Error("Cross-repository request")
        if (path === `/repos/team/${repo}/issues/1` && method === "GET")
          return Response.json({
            number: 1,
            state: "open",
            title: args.title,
            body: args.body,
            html_url: issueUrl,
            labels: labels.map((name) => ({ name })),
          })
        if (path === `/repos/team/${repo}/labels` && method === "GET")
          return Response.json([{ name: "bug", description: "Bug" }])
        if (path === `/repos/team/${repo}/issues/1/labels` && method === "POST") {
          labels = ["bug"]
          return Response.json([{ name: "bug" }])
        }
        if (path === `/repos/team/${repo}/issues/1/comments` && method === "GET") return Response.json(comments)
        if (path === `/repos/team/${repo}/issues/1/comments` && method === "POST") {
          writes++
          const payload = JSON.parse(String(init?.body)) as { body: string }
          const comment = {
            id: writes,
            html_url: `${issueUrl}#issuecomment-${writes}`,
            body: payload.body,
            user: { login: "bot[bot]" },
          }
          comments.push(comment)
          return Response.json(comment, { status: 201 })
        }
        throw new Error(`Unexpected request ${method} ${path}`)
      },
    },
  })
  return {
    client,
    comments,
    requests,
    get writes() {
      return writes
    },
  }
}

describe("repository-scoped issue effects", () => {
  it("checks the current issue and configured label before an idempotent label write", async () => {
    const { client, requests } = mockClient()
    expect((await readIssueLabels(client, scope, 1, args.title, args.body)).labels).toEqual([
      { name: "bug", description: "Bug" },
    ])
    await expect(ensureIssueLabel(client, scope, { ...args, label: "invented", allowed: ["bug"] })).rejects.toThrow(
      "Unsupported",
    )
    expect(await ensureIssueLabel(client, scope, { ...args, label: "bug", allowed: ["bug"] })).toEqual({
      label: "bug",
      applied: true,
    })
    expect(await ensureIssueLabel(client, scope, { ...args, label: "bug", allowed: ["bug"] })).toEqual({
      label: "bug",
      applied: true,
    })
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1)
    await expect(readIssueLabels(client, scope, 1, "Changed", args.body)).rejects.toThrow("changed")
  })

  it("does not add a label when policy is revoked during the preceding GitHub reads", async () => {
    const { client, requests } = mockClient()
    await expect(
      ensureIssueLabel(client, scope, {
        ...args,
        label: "bug",
        allowed: ["bug"],
        beforeWrite: async () => {
          throw new Error("Repository was disabled")
        },
      }),
    ).rejects.toThrow("disabled")
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  it("reconciles a lost comment acknowledgement with the signed marker without a second write", async () => {
    const fixture = mockClient()
    const { client, comments } = fixture
    const receipts = receiptStore()
    const commentScope = { ...scope, namespace: "r4", secret: "private-test-key", bot: "bot[bot]" }
    const input = { number: 1, key: "issue-1-repro-v1", kind: "repro", body: "Evidence" }
    const first = await ensureIssueComment(client, commentScope, receipts, input)
    expect(first.alreadyPosted).toBe(false)
    expect(comments[0]?.body).toContain("<!-- r4-repro:")
    receipts.state.clear() // Simulate a lost local acknowledgement after GitHub accepted the comment.
    const second = await ensureIssueComment(client, commentScope, receipts, input)
    expect(second).toEqual({ url: first.url, alreadyPosted: true })
    expect(comments).toHaveLength(1)
    expect(fixture.writes).toBe(1)
    expect(receipts.state.get("team/first:repro-comment:1:issue-1-repro-v1")).toEqual({ url: first.url })
  })

  it("reconciles R4's historical marker and receipt key without changing its digest", async () => {
    const fixture = mockClient()
    const secret = "legacy-secret"
    const key = "issue-1-repro-v1"
    const imported = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const hash = new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(`r4:1:${key}`)))
    const marker = `<!-- r4-repro:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")} -->`
    fixture.comments.push({
      id: 13,
      html_url: "https://github.com/team/first/issues/1#issuecomment-13",
      body: marker,
      user: { login: "leostera" },
    })
    const receipts = receiptStore()
    const result = await ensureIssueComment(
      fixture.client,
      {
        ...scope,
        namespace: "r4",
        markerIdentity: "r4",
        receiptPrefix: "",
        secret,
        bot: "bot[bot]",
        historicalAuthor: "leostera",
      },
      receipts,
      { number: 1, key, kind: "repro", body: "Evidence" },
    )
    expect(result.alreadyPosted).toBe(true)
    expect(fixture.writes).toBe(0)
    expect(receipts.state.get("repro-comment:1:issue-1-repro-v1")).toEqual({ url: result.url })
  })

  it("separates markers and receipts when two repositories share the same issue and key", async () => {
    const first = mockClient("first")
    const second = mockClient("second")
    const receipts = receiptStore() // Even a shared DO cannot collide on repository-qualified receipts.
    const input = { number: 1, key: "issue-1-repro-v1", kind: "repro", body: "Evidence" }
    const common = { namespace: "clankwerk", secret: "shared-secret", bot: "bot[bot]" }
    await ensureIssueComment(first.client, { ...common, owner: "team", repo: "first" }, receipts, input)
    await ensureIssueComment(second.client, { ...common, owner: "team", repo: "second" }, receipts, input)
    expect(first.comments[0]?.body).not.toBe(second.comments[0]?.body)
    expect(receipts.state.size).toBe(2)
    expect(first.writes).toBe(1)
    expect(second.writes).toBe(1)
  })

  it("rejects cross-repo or closed/stale issue writes", async () => {
    const { client } = mockClient()
    await expect(readIssueLabels(client, { owner: "team", repo: "other" }, 1, args.title, args.body)).rejects.toThrow(
      "Cross-repository",
    )
    await expect(
      ensureIssueComment(client, { ...scope, namespace: "r4", secret: "secret", bot: "bot[bot]" }, receiptStore(), {
        number: 1,
        key: "not a valid key!",
        kind: "repro",
        body: "Body",
      }),
    ).rejects.toThrow("Invalid")
  })
})
