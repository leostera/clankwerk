import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { issueInstallationToken } from "./github-app.js"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString()
const base = {
  clientId: "Iv12345678901234567890",
  appId: 42,
  privateKey: pem,
  owner: "leostera",
  repo: "r4",
  permissions: { issues: "write" as const },
}

describe("GitHub App installation token", () => {
  it("signs an App JWT and constrains issuance to the expected repository and permissions", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "user-agent": "clankwerk" })
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /)
      if (String(input).endsWith("/installation")) return Response.json({ id: 123, app_id: 42, app_slug: "leo-r4" })
      expect(String(input)).toBe("https://api.github.com/app/installations/123/access_tokens")
      expect(JSON.parse(init!.body as string)).toEqual({ repositories: ["r4"], permissions: { issues: "write" } })
      return Response.json({
        token: "ghs_fake-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        repositories: [{ full_name: "leostera/r4" }],
        permissions: { issues: "write", metadata: "read" },
      })
    })
    const result = await issueInstallationToken({ ...base, fetch: request as typeof fetch })
    expect(result).toMatchObject({ token: "ghs_fake-token", bot: "leo-r4[bot]" })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("fails closed when a token covers another repository", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/installation")
        ? Response.json({ id: 123, app_id: 42, app_slug: "leo-r4" })
        : Response.json({
            token: "ghs_fake-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            repositories: [{ full_name: "leostera/other" }],
            permissions: { issues: "write" },
          }),
    )
    await expect(issueInstallationToken({ ...base, fetch: request as typeof fetch })).rejects.toThrow(
      "repository-scoped",
    )
  })
  it("fails closed for an installation belonging to a different App", async () => {
    const request = vi.fn(async () => Response.json({ id: 123, app_id: 5, app_slug: "other" }))
    await expect(issueInstallationToken({ ...base, fetch: request as typeof fetch })).rejects.toThrow("not installed")
    expect(request).toHaveBeenCalledTimes(1)
  })
})
