import { describe, expect, it } from "vitest"
import { Id } from "../graph/id.js"
import { Triggers } from "../graph/trigger.js"
import { dispatchWebhook } from "./webhook.js"

const url = "https://triggers.example.test/github/events"
const received: string[] = []
const verify = (request: Request) => {
  received.push("verify")
  if (request.headers.get("x-signature") !== "valid") throw new Error("Invalid signature")
}
const issue = Triggers.webhook({
  id: Id.trigger("issue-opened"),
  path: "/github/events",
  verify,
  decode: async (request) => {
    received.push("issue-decode")
    const event = (await request.json()) as { kind: string; number: number }
    return event.kind === "issue" ? event : undefined
  },
  key: (value) => `issue:${value.number}`,
})
const pull = Triggers.webhook({
  id: Id.trigger("pr-head"),
  path: "/github/events",
  verify,
  decode: async (request) => {
    received.push("pull-decode")
    const event = (await request.json()) as { kind: string; number: number; head: string }
    return event.kind === "pull" ? event : undefined
  },
  key: (value) => `pr:${value.number}:${value.head}`,
})
const workflows = [
  { id: "contribute", graph: issue },
  { id: "code-review", graph: pull },
]
const request = (body: string, signature = "valid") =>
  new Request(url, {
    method: "POST",
    body,
    headers: { "x-signature": signature },
  })

describe("webhook trigger dispatch", () => {
  it("verifies and decodes each matching declared trigger and dispatches only the matching workflow", async () => {
    received.length = 0
    const activations: unknown[] = []
    const result = await dispatchWebhook(
      request('{"kind":"pull","number":5,"head":"abc"}'),
      workflows,
      async (event) => {
        activations.push(event)
      },
    )
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pr:5:abc")))
    const key = `code-review:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    expect(activations).toEqual([
      {
        workflowId: "code-review",
        triggerId: Id.trigger("pr-head"),
        key,
        partition: key,
        value: { kind: "pull", number: 5, head: "abc" },
      },
    ])
    expect(result).toEqual(activations)
    expect(received).toEqual(["verify", "verify", "issue-decode", "pull-decode"])
  })

  it("correlates distinct signed events to the same serial workflow partition", async () => {
    const workflow = {
      id: "contribute",
      graph: pull,
      partition: (_triggerId: string, value: unknown) => `repo:issue:${(value as { number: number }).number}`,
    }
    const events: unknown[] = []
    const one = await dispatchWebhook(request('{"kind":"pull","number":5,"head":"a"}'), [workflow], async (event) => {
      events.push(event)
    })
    const two = await dispatchWebhook(request('{"kind":"pull","number":5,"head":"b"}'), [workflow], async (event) => {
      events.push(event)
    })
    expect(one[0]!.key).not.toBe(two[0]!.key)
    expect(one[0]!.partition).toBe(two[0]!.partition)
  })

  it("never decodes or activates an unauthenticated event", async () => {
    received.length = 0
    await expect(
      dispatchWebhook(request('{"kind":"issue","number":4}', "bad"), workflows, async () => {
        throw new Error("must not activate")
      }),
    ).rejects.toThrow("Invalid signature")
    expect(received).toEqual(["verify"])
  })

  it("fails closed on missing verification and oversized streamed bodies", async () => {
    const unverified = Triggers.webhook({
      id: Id.trigger("unsafe"),
      path: "/github/events",
      decode: () => ({ n: 1 }),
      key: (value) => `n:${value.n}`,
    })
    await expect(dispatchWebhook(request("{}"), [{ id: "unsafe", graph: unverified }], async () => {})).rejects.toThrow(
      "Incomplete webhook trigger",
    )
    await expect(dispatchWebhook(request("x".repeat(100)), workflows, async () => {}, 40)).rejects.toThrow(
      "exceeds limit",
    )
  })
})
