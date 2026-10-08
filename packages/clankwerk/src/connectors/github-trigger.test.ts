import { expect, test } from "vitest"
import { githubTriggers } from "./github-trigger.js"
import { dispatchWebhook } from "../runtime/webhook.js"

const secret = "test-github-secret"
const route = "https://triggers-r4.leostera.dev/github/issues"
const encoder = new TextEncoder()
async function signed(event: string, payload: unknown, signatureSecret = secret): Promise<Request> {
  const body = JSON.stringify(payload)
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signatureSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  return new Request(route, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "00000000-0000-4000-8000-000000000001",
      "x-hub-signature-256": `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    },
  })
}
const repository = { owner: { login: "leostera" }, name: "r4", full_name: "leostera/r4" }
const triggers = githubTriggers({ secret, repository: "leostera/r4", path: "/github/issues" })

async function activate(request: Request, name: keyof typeof triggers) {
  const definition = triggers[name].triggers[0]!
  const bytes = await request.clone().arrayBuffer()
  const replay = () => new Request(request.url, { method: "POST", headers: request.headers, body: bytes.slice(0) })
  await definition.verify!(replay())
  return definition.decode!(replay())
}

test("the signed GitHub source activates a declared Clankwerk workflow trigger", async () => {
  const request = await signed("pull_request", {
    action: "synchronize",
    repository,
    pull_request: { number: 5, head: { sha: "a".repeat(40) }, html_url: "https://github.com/leostera/r4/pull/5" },
  })
  const activated: unknown[] = []
  const matches = await dispatchWebhook(request, [{ id: "code-review", graph: triggers.pull }], async (event) => {
    activated.push(event)
  })
  expect(matches).toEqual(activated)
  expect(activated).toHaveLength(1)
  expect(matches[0]).toMatchObject({
    workflowId: "code-review",
    triggerId: triggers.pull.triggers[0]!.id,
    value: { repository: "leostera/r4", number: 5, head: "a".repeat(40) },
  })
})

test("signed base-branch pushes activate a declared push trigger for base-sync workflows", async () => {
  const scoped = githubTriggers({ secret, repository: "leostera/r4", path: "/github/issues", baseBranch: "main" })
  const base = await signed("push", { repository, ref: "refs/heads/main", after: "c".repeat(40), deleted: false })
  const definition = scoped.push.triggers[0]!
  const bytes = await base.clone().arrayBuffer()
  const replay = () => new Request(base.url, { method: "POST", headers: base.headers, body: bytes.slice(0) })
  await definition.verify!(replay())
  expect(await definition.decode!(replay())).toMatchObject({ branch: "main", head: "c".repeat(40) })
  const unrelated = await signed("push", { repository, ref: "refs/heads/feature", after: "d".repeat(40) })
  expect(await scoped.push.triggers[0]!.decode!(unrelated)).toBeUndefined()
})

test("one-run-per-issue admission joins reopened deliveries without changing the default", () => {
  const shared = githubTriggers({
    secret,
    repository: "leostera/r4",
    path: "/github/issues",
    issueIdentity: "per-issue",
  })
  const opened = { repository: "leostera/r4", number: 4, action: "opened", deliveryId: "first" }
  const reopened = { ...opened, action: "reopened", deliveryId: "second" }
  expect(shared.issue.triggers[0]!.key!(opened)).toBe(shared.issue.triggers[0]!.key!(reopened))
  expect(triggers.issue.triggers[0]!.key!(opened)).not.toBe(triggers.issue.triggers[0]!.key!(reopened))
})

test("issue and PR events activate only their declared verified triggers", async () => {
  const issue = await signed("issues", {
    action: "opened",
    repository,
    issue: {
      number: 4,
      title: "Fix docs",
      body: "Scope",
      html_url: "https://github.com/leostera/r4/issues/4",
      user: { login: "leostera" },
    },
  })
  expect(await activate(issue, "issue")).toMatchObject({ number: 4, repository: "leostera/r4" })
  expect(await activate(issue, "pull")).toBeUndefined()
  const pull = await signed("pull_request", {
    action: "synchronize",
    repository,
    pull_request: { number: 5, head: { sha: "a".repeat(40) }, html_url: "https://github.com/leostera/r4/pull/5" },
  })
  expect(await activate(pull, "pull")).toMatchObject({ number: 5, head: "a".repeat(40) })
  expect(await activate(pull, "issue")).toBeUndefined()
})

test("unsigned PR feedback never reaches the decoder; signed PR comments are workflow data", async () => {
  const review = await signed(
    "pull_request_review",
    {
      action: "submitted",
      repository,
      pull_request: { number: 5 },
      review: { id: 123, commit_id: "b".repeat(40), body: "Findings" },
    },
    "wrong",
  )
  await expect(activate(review, "review")).rejects.toThrow("Invalid GitHub webhook signature")
  const base = { action: "created", repository, issue: { number: 5, pull_request: { url: "url" } } }
  const ordinary = await signed("issue_comment", {
    ...base,
    comment: { id: 99, body: "not an instruction", user: { login: "leostera" } },
  })
  expect(await activate(ordinary, "comment")).toMatchObject({ number: 5, body: "not an instruction" })
  const command = await signed("issue_comment", {
    ...base,
    comment: { id: 100, body: "/r4 revise: fix tests", user: { login: "leostera" } },
  })
  expect(await activate(command, "comment")).toMatchObject({ number: 5, commentId: 100 })
})
