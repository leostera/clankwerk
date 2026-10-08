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
const url = "https://github.com/team/first/issues/1"
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
function mockClient() {
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
        if (!path.startsWith("/repos/team/first/")) throw new Error("Cross-repository request")
        if (path === "/repos/team/first/issues/1" && method === "GET")
          return Response.json({
            number: 1,
            state: "open",
            title: args.title,
            body: args.body,
            html_url: url,
            labels: labels.map((name) => ({ name })),
          })
        if (path === "/repos/team/first/labels" && method === "GET")
          return Response.json([{ name: "bug", description: "Bug" }])
        if (path === "/repos/team/first/issues/1/labels" && method === "POST") {
          labels = ["bug"]
          return Response.json([{ name: "bug" }])
        }
        if (path === "/repos/team/first/issues/1/comments" && method === "GET") return Response.json(comments)
        if (path === "/repos/team/first/issues/1/comments" && method === "POST") {
          writes++
          const payload = JSON.parse(String(init?.body)) as { body: string }
          const comment = {
            id: writes,
            html_url: `${url}#issuecomment-${writes}`,
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
    expect(receipts.state.get("repro-comment:1:issue-1-repro-v1")).toEqual({ url: first.url })
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
