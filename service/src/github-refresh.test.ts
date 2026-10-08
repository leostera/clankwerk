import { describe, expect, it, vi } from "vitest"
import { refreshToken } from "@octokit/oauth-methods"
import { refreshGitHubToken } from "./github-oauth.ts"

vi.mock("@octokit/oauth-methods", () => ({ refreshToken: vi.fn() }))
const old = `ghr_${"a".repeat(36)}`
const next = `ghr_${"b".repeat(36)}`
const access = `ghu_${"c".repeat(36)}`

describe("GitHub user token rotation", () => {
  it("uses Octokit's GitHub App refresh flow and returns only credentials the instance needs", async () => {
    vi.mocked(refreshToken).mockResolvedValueOnce({
      data: {
        access_token: access,
        refresh_token: next,
        expires_in: 28_800,
        refresh_token_expires_in: 15_552_000,
        token_type: "bearer",
      },
    } as Awaited<ReturnType<typeof refreshToken>>)
    const rotated = await refreshGitHubToken(old, "public-client-id", "test-only-client-secret")
    expect(refreshToken).toHaveBeenCalledWith({
      clientType: "github-app",
      clientId: "public-client-id",
      clientSecret: "test-only-client-secret",
      refreshToken: old,
    })
    expect(rotated.accessToken).toBe(access)
    expect(rotated.refreshToken).toBe(next)
    expect(rotated.expiresAt).toBeGreaterThan(Date.now() + 60_000)
    expect(Object.keys(rotated).sort()).toEqual(["accessToken", "expiresAt", "refreshExpiresAt", "refreshToken"])
  })
  it("rejects malformed refresh credentials before sending anything upstream", async () => {
    vi.mocked(refreshToken).mockClear()
    await expect(refreshGitHubToken("invalid", "id", "secret")).rejects.toThrow("Invalid")
    expect(refreshToken).not.toHaveBeenCalled()
  })
})
