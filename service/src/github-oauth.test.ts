import { describe, expect, it } from "vitest"
import { base64url, pkceChallenge, registeredReturnTo } from "./github-oauth.ts"

const allowed = "https://example.test/api/connectors/github/complete"
describe("GitHub OAuth return URL and PKCE", () => {
  it("accepts only the exact registered HTTPS callback", () => {
    expect(registeredReturnTo(allowed, allowed)).toBe(allowed)
    for (const value of [
      "https://evil.example/api/connectors/github/complete",
      "http://example.test/api/connectors/github/complete",
      `${allowed}?next=https://evil.example`,
      "https://example.test.evil.example/api/connectors/github/complete",
      "https://evil@example.test/api/connectors/github/complete",
      `${allowed}#fragment`,
    ])
      expect(() => registeredReturnTo(value, allowed)).toThrow()
  })
  it("creates a 43-character SHA-256 PKCE challenge", async () => {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await pkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
