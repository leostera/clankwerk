import { describe, expect, it } from "vitest"
import { signInstanceRequest, verifyInstanceRequest } from "./github-authorization.js"

const secret = "test-key-only-not-a-production-credential-12345"
const url = "https://clankwerk.leostera.dev/internal/start"

describe("instance-bound GitHub authorization requests", () => {
  it("accepts a fresh authenticated body", async () => {
    const body = JSON.stringify({ instance: "instance-a", returnTo: "https://example.test/callback" })
    const request = new Request(url, { method: "POST", headers: await signInstanceRequest(body, secret), body })
    expect(await verifyInstanceRequest(request, secret, new TextEncoder().encode(body))).toBe(true)
  })
  it("rejects different bodies, keys and expired signatures", async () => {
    const body = "{}"
    const headers = await signInstanceRequest(body, secret)
    expect(
      await verifyInstanceRequest(new Request(url, { headers }), secret, new TextEncoder().encode('{"other":true}')),
    ).toBe(false)
    expect(
      await verifyInstanceRequest(
        new Request(url, { headers }),
        "other-key-not-a-production-credential-12345",
        new TextEncoder().encode(body),
      ),
    ).toBe(false)
    const old = await signInstanceRequest(body, secret, Date.now() - 120_000)
    expect(
      await verifyInstanceRequest(new Request(url, { headers: old }), secret, new TextEncoder().encode(body)),
    ).toBe(false)
  })
})
