import { describe, expect, it, vi } from "vitest"
import { handleGitHubWebhook, verifyGitHubSignature } from "./github-webhook.ts"

const secret = "test-only-webhook-secret"
const url = "https://clankwerk.leostera.dev/hooks/github"
const delivery = "66a126fb-25a8-4edf-a754-a959706363db"
async function signed(event: string, payload: unknown, withSecret = secret) {
  const body = JSON.stringify(payload)
  const raw = new TextEncoder().encode(body)
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(withSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw))
  const signature = `sha256=${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`
  return new Request(url, {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": signature, "x-github-delivery": delivery, "x-github-event": event },
  })
}
const payload = {
  action: "created",
  installation: {
    id: 123,
    account: { id: 234, login: "leostera" },
    repository_selection: "selected",
  },
}

describe("GitHub App webhook", () => {
  it("rejects unsigned, modified and unconfigured deliveries", async () => {
    const record = vi.fn()
    expect((await handleGitHubWebhook(new Request(url, { method: "POST", body: "{}" }), secret, record)).status).toBe(
      401,
    )
    expect((await handleGitHubWebhook(await signed("installation", payload, "wrong-key"), secret, record)).status).toBe(
      401,
    )
    expect((await handleGitHubWebhook(await signed("installation", payload), undefined, record)).status).toBe(503)
    expect(record).not.toHaveBeenCalled()
  })
  it("records signed installation events without credentials", async () => {
    const record = vi.fn(async () => undefined)
    const response = await handleGitHubWebhook(await signed("installation", payload), secret, record)
    expect(response.status).toBe(202)
    expect(record).toHaveBeenCalledWith({
      delivery,
      action: "created",
      installationId: 123,
      accountId: 234,
      accountLogin: "leostera",
      repositorySelection: "selected",
    })
  })
  it("ignores unrelated signed events and retries storage failure", async () => {
    const record = vi.fn(async () => {
      throw new Error("storage failed")
    })
    expect((await handleGitHubWebhook(await signed("issues", { action: "opened" }), secret, record)).status).toBe(202)
    expect((await handleGitHubWebhook(await signed("installation", payload), secret, record)).status).toBe(503)
    expect(record).toHaveBeenCalledTimes(1)
  })
  it("uses HMAC verification, not a string comparison", async () => {
    const req = await signed("installation", payload)
    expect(
      await verifyGitHubSignature(
        new TextEncoder().encode(await req.text()),
        req.headers.get("x-hub-signature-256"),
        secret,
      ),
    ).toBe(true)
    expect(await verifyGitHubSignature(new Uint8Array([0]), "sha256=" + "0".repeat(64), secret)).toBe(false)
  })
})
