import { describe, expect, it, vi } from "vitest"
import { dispatchWebhook } from "../runtime/webhook.js"
import { dispatchGitHubApp, githubAppTriggers } from "./github-app-source.js"
import type { RepositoryPolicy } from "./github-repository-policy.js"

const secret = "source-secret"
const path = "/hooks/github"
const source = githubAppTriggers(path)
const issue = { id: "triage", graph: source.issue }
const pull = { id: "review", graph: source.pull }
const policy = (id: number, name: string): RepositoryPolicy => ({
  id,
  fullName: `team/${name}`,
  installationId: 8,
  base: "main",
  revision: 1,
  enabled: true,
  workflows: ["triage", "review"],
  minimumIssue: 1,
})
async function signed(id: number, name: string, event: "issues" | "pull_request" = "issues", key = secret) {
  const repo = { id, owner: { login: "team" }, name, full_name: `team/${name}` }
  const body = JSON.stringify({
    action: event === "issues" ? "opened" : "synchronize",
    repository: repo,
    installation: { id: 8 },
    ...(event === "issues"
      ? {
          issue: {
            number: 1,
            title: "First",
            body: "Text",
            html_url: `https://github.com/team/${name}/issues/1`,
            user: { login: "dev" },
          },
        }
      : {
          pull_request: {
            number: 1,
            head: { sha: "a".repeat(40) },
            html_url: `https://github.com/team/${name}/pull/1`,
          },
        }),
  })
  const signer = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", signer, new TextEncoder().encode(body)))
  return new Request(`https://triggers.test${path}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "00000000-0000-4000-8000-000000000001",
      "x-hub-signature-256": `sha256=${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`,
    },
  })
}
const options = (policies: Map<number, RepositoryPolicy>) => ({
  path,
  secret,
  workflows: { issue, pull },
  policy: vi.fn(async (id: number) => policies.get(id)),
  installation: vi.fn(async (repo: { id: number; fullName: string }) => ({ ...repo, installationId: 8, base: "main" })),
  activate: vi.fn(async () => {}),
})

describe("App-wide source admission", () => {
  it("admits two enabled repos in one build and keeps their issue and PR keys distinct", async () => {
    const config = options(
      new Map([
        [11, policy(11, "first")],
        [12, policy(12, "second")],
      ]),
    )
    const a = await dispatchGitHubApp(await signed(11, "first"), config)
    const b = await dispatchGitHubApp(await signed(12, "second"), config)
    expect(a[0]?.key).not.toBe(b[0]?.key)
    expect(a[0]?.value).toMatchObject({ repository: { id: 11, fullName: "team/first" }, number: 1 })
    const pr = await dispatchGitHubApp(await signed(12, "second", "pull_request"), config)
    expect(pr[0]).toMatchObject({ workflowId: "review", value: { head: "a".repeat(40), repository: { id: 12 } } })
    expect(config.activate).toHaveBeenCalledTimes(3)
  })

  it("never looks up policy or starts a run for a bad signature", async () => {
    const config = options(new Map([[11, policy(11, "first")]]))
    await expect(dispatchGitHubApp(await signed(11, "first", "issues", "wrong"), config)).rejects.toThrow("signature")
    expect(config.installation).not.toHaveBeenCalled()
    expect(config.policy).not.toHaveBeenCalled()
    expect(config.activate).not.toHaveBeenCalled()
  })

  it("rejects disabled, wrong-installation and unconfigured repositories", async () => {
    const config = options(new Map([[11, { ...policy(11, "first"), enabled: false }]]))
    expect(await dispatchGitHubApp(await signed(11, "first"), config)).toEqual([])
    expect(await dispatchGitHubApp(await signed(12, "second"), config)).toEqual([])
    expect(config.activate).not.toHaveBeenCalled()
    config.installation.mockImplementationOnce(async (repo) => ({ ...repo, installationId: 99, base: "main" }))
    await expect(dispatchGitHubApp(await signed(11, "first"), config)).rejects.toThrow("installation")
  })

  it("cannot bypass source-level auth by calling the generic webhook dispatcher", async () => {
    const activate = vi.fn()
    await expect(dispatchWebhook(await signed(11, "first"), [issue], activate)).rejects.toThrow("source-level")
    expect(activate).not.toHaveBeenCalled()
  })
})
