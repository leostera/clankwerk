import { describe, expect, it } from "vitest"
import { readSignedGitHubEvent } from "./github-app-event.js"

const secret = "app-test-secret"
const repository = (id: number, name: string) => ({
  id,
  owner: { login: "team" },
  name,
  full_name: `team/${name}`,
})
const issue = (repo: ReturnType<typeof repository>) => ({
  action: "opened",
  repository: repo,
  installation: { id: 7 },
  issue: {
    number: 1,
    title: "First issue",
    body: "Description",
    html_url: `https://github.com/${repo.full_name}/issues/1`,
    user: { login: "author" },
  },
})
async function signed(payload: unknown, event = "issues", key = secret, raw?: string) {
  const body = raw ?? JSON.stringify(payload)
  const bytes = new TextEncoder().encode(body)
  const secretKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", secretKey, bytes))
  return new Request("https://triggers.test/hooks/github", {
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

describe("signed App-wide webhook decoding (not admission)", () => {
  it("reads two distinct repos with the same issue number without choosing a compile-time repository", async () => {
    const a = await readSignedGitHubEvent(await signed(issue(repository(11, "first"))), secret)
    const b = await readSignedGitHubEvent(await signed(issue(repository(12, "second"))), secret)
    expect(a).toMatchObject({
      kind: "issue",
      number: 1,
      repository: { id: 11, fullName: "team/first", installationId: 7 },
    })
    expect(b).toMatchObject({ kind: "issue", number: 1, repository: { id: 12, fullName: "team/second" } })
    expect(a?.bodyDigest).not.toBe(b?.bodyDigest)
  })

  it("rejects a wrong signature before attempting to parse an invalid JSON body", async () => {
    const raw = "not JSON"
    await expect(readSignedGitHubEvent(await signed({}, "issues", "wrong", raw), secret)).rejects.toThrow("signature")
    await expect(readSignedGitHubEvent(await signed({}, "issues", secret, raw), secret)).rejects.toThrow()
  })

  it("checks numeric repository identity and permits a legacy repository hook without installation metadata", async () => {
    const payload = issue(repository(11, "first"))
    await expect(
      readSignedGitHubEvent(await signed({ ...payload, repository: { ...payload.repository, id: "11" } }), secret),
    ).rejects.toThrow("identity")
    await expect(
      readSignedGitHubEvent(
        await signed({ ...payload, repository: { ...payload.repository, full_name: "team/other" } }),
        secret,
      ),
    ).rejects.toThrow("identity")
    const event = await readSignedGitHubEvent(await signed({ ...payload, installation: undefined }), secret)
    expect(event?.repository).toEqual({ id: 11, fullName: "team/first" })
  })

  it("decodes exact-head PRs and ignores unrelated actions", async () => {
    const repo = repository(12, "second")
    const payload = {
      action: "synchronize",
      repository: repo,
      installation: { id: 7 },
      pull_request: {
        number: 1,
        head: { sha: "a".repeat(40) },
        html_url: `https://github.com/${repo.full_name}/pull/1`,
      },
    }
    expect(await readSignedGitHubEvent(await signed(payload, "pull_request"), secret)).toMatchObject({
      kind: "pull",
      number: 1,
      head: "a".repeat(40),
    })
    expect(
      await readSignedGitHubEvent(await signed({ ...payload, action: "closed" }, "pull_request"), secret),
    ).toBeUndefined()
    await expect(
      readSignedGitHubEvent(
        await signed({ ...payload, pull_request: { ...payload.pull_request, head: { sha: "wrong" } } }, "pull_request"),
        secret,
      ),
    ).rejects.toThrow("pull request")
  })

  it("bounds the raw body before decoding", async () => {
    await expect(readSignedGitHubEvent(await signed(issue(repository(11, "first"))), secret, 80)).rejects.toThrow(
      "size limit",
    )
  })
})
