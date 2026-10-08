import { describe, expect, it, vi } from "vitest"
import { githubWorkflowCapability } from "./github-workflow-context.js"
import type { RepositoryPolicy } from "./github-repository-policy.js"

const enabled: RepositoryPolicy = {
  id: 11,
  fullName: "team/first",
  installationId: 8,
  base: "main",
  revision: 2,
  enabled: true,
  workflows: ["triage"],
  minimumIssue: 1,
}
const token = "ghs_fake-repository-only-token"
const issueToken = vi.fn(async () => ({
  token,
  repositoryId: 11,
  installationId: 8,
  bot: "bot[bot]",
  expiresAt: Date.now() + 60_000,
}))
function setup(initial = enabled) {
  let current = initial
  const capability = githubWorkflowCapability({
    repository: { id: 11, fullName: "team/first", installationId: 8 },
    workflowId: "triage",
    policy: async () => current,
    allowedPermissions: { issues: "write", contents: "read" },
    app: { appId: 42, clientId: "fake-client", privateKey: "private" },
    issueToken,
  })
  return {
    capability,
    update: (next: RepositoryPolicy) => {
      current = next
    },
  }
}

describe("trusted workflow's scoped Octokit capability", () => {
  it("uses the active repository identity and limited permissions, without exposing the token in the scope", async () => {
    issueToken.mockClear()
    const { capability } = setup()
    const result = await capability.withOctokit({ contents: "read" }, async (client, scope) => {
      expect(client.rest.repos.get).toBeTypeOf("function")
      expect(scope).toEqual({ repositoryId: 11, installationId: 8, owner: "team", repo: "first", base: "main" })
      expect(JSON.stringify(scope)).not.toContain(token)
      return scope.base
    })
    expect(result).toBe("main")
    expect(issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "team", repo: "first", repositoryId: 11, permissions: { contents: "read" } }),
    )
  })

  it("blocks REST reads of a different repo and non-repo APIs even when the token could read public data", async () => {
    const { capability } = setup()
    const fetcher = vi.fn()
    await capability.withOctokit({ contents: "read" }, async (client) => {
      await expect(
        client.request("GET /repos/{owner}/{repo}", {
          owner: "team",
          repo: "other",
          request: { fetch: fetcher },
        }),
      ).rejects.toThrow("outside the enabled repository")
      await expect(client.request("GET /user", { request: { fetch: fetcher } })).rejects.toThrow(
        "outside the enabled repository",
      )
      expect(fetcher).not.toHaveBeenCalled()
    })
  })

  it("refuses undeclared permissions, a changed repo or a disabled workflow", async () => {
    issueToken.mockClear()
    const { capability, update } = setup()
    await expect(capability.withOctokit({ contents: "write" }, async () => 1)).rejects.toThrow("permissions")
    await expect(capability.withOctokit({ pull_requests: "write" }, async () => 1)).rejects.toThrow("permissions")
    expect(issueToken).not.toHaveBeenCalled()
    update({ ...enabled, enabled: false })
    await expect(capability.withOctokit({ issues: "write" }, async () => 1)).rejects.toThrow("not enabled")
    update({ ...enabled, fullName: "team/renamed" })
    await expect(capability.withOctokit({ issues: "write" }, async () => 1)).rejects.toThrow("not enabled")
  })

  it("rejects a disable while minting a token, a different installation, and a returned token", async () => {
    const { capability, update } = setup()
    issueToken.mockImplementationOnce(async () => {
      update({ ...enabled, enabled: false, revision: 3 })
      return { token, repositoryId: 11, installationId: 8, bot: "bot[bot]", expiresAt: Date.now() + 60_000 }
    })
    await expect(capability.withOctokit({ contents: "read" }, async () => 1)).rejects.toThrow("policy changed")
    update(enabled)
    issueToken.mockImplementationOnce(async () => ({
      token,
      repositoryId: 11,
      installationId: 9,
      bot: "bot[bot]",
      expiresAt: Date.now() + 60_000,
    }))
    await expect(capability.withOctokit({ contents: "read" }, async () => 1)).rejects.toThrow("installation changed")
    await expect(capability.withOctokit({ contents: "read" }, async () => token)).rejects.toThrow("credential")
  })
})
