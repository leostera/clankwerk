import { describe, expect, it } from "vitest"
import { claimGitHubDelivery, type GitHubClaimStorage } from "./github-delivery-claim.js"
import type { RepositoryPolicy } from "./github-repository-policy.js"

// The test store has the same transaction shape as Cloudflare's real Durable Object storage.
const durableStorageCompatibility: (storage: DurableObjectStorage) => GitHubClaimStorage = (storage) => storage
void durableStorageCompatibility

const policy: RepositoryPolicy = {
  id: 11,
  fullName: "team/first",
  installationId: 8,
  base: "main",
  revision: 1,
  enabled: true,
  workflows: ["triage"],
  minimumIssue: 1,
}
function store(): { storage: GitHubClaimStorage; records: Map<string, unknown> } {
  const records = new Map<string, unknown>([["repository-policy", policy]])
  return {
    records,
    storage: {
      async transaction<T>(
        fn: (tx: {
          get<V>(key: string): Promise<V | undefined>
          put(key: string, value: unknown): Promise<void>
        }) => Promise<T>,
      ): Promise<T> {
        const snapshot = new Map(records)
        const result = await fn({
          get: async <V>(key: string) => snapshot.get(key) as V | undefined,
          put: async (key, value) => {
            snapshot.set(key, value)
          },
        })
        records.clear()
        for (const [key, value] of snapshot) records.set(key, value)
        return result
      },
    },
  }
}
const candidate = (deliveryId: string, fingerprint = "a".repeat(64), key = `triage:${"b".repeat(64)}`) => ({
  repository: { id: 11, fullName: "team/first", installationId: 8 },
  issueNumber: 1,
  activation: { workflowId: "triage", triggerId: "github-app-issue", key, partition: key, value: {} },
  delivery: { id: deliveryId, digest: fingerprint },
  runId: "run-first",
})
const first = "00000000-0000-4000-8000-000000000001"
const second = "00000000-0000-4000-8000-000000000002"

describe("per-repository atomic GitHub claims", () => {
  it("redelivers the same claim and joins a different hook delivery to the original run", async () => {
    const { storage } = store()
    expect(await claimGitHubDelivery(storage, candidate(first))).toEqual({ runId: "run-first", duplicate: false })
    expect(await claimGitHubDelivery(storage, { ...candidate(first), runId: "run-later" })).toEqual({
      runId: "run-first",
      duplicate: true,
    })
    expect(await claimGitHubDelivery(storage, { ...candidate(second, "c".repeat(64)), runId: "run-later" })).toEqual({
      runId: "run-first",
      duplicate: true,
    })
  })
  it("rejects changed bytes with a reused delivery ID and leaves prior claim intact", async () => {
    const { storage } = store()
    await claimGitHubDelivery(storage, candidate(first))
    await expect(claimGitHubDelivery(storage, candidate(first, "c".repeat(64)))).rejects.toThrow("Conflicting")
    await expect(
      claimGitHubDelivery(storage, candidate(first, "a".repeat(64), `triage:${"d".repeat(64)}`)),
    ).rejects.toThrow("Conflicting")
    expect(await claimGitHubDelivery(storage, candidate(first))).toMatchObject({ runId: "run-first" })
  })
  it("rechecks policy inside the claim transaction before any run is launched", async () => {
    const { storage, records } = store()
    records.set("repository-policy", { ...policy, enabled: false })
    await expect(claimGitHubDelivery(storage, candidate(first))).rejects.toThrow("not enabled")
    expect([...records.keys()]).toEqual(["repository-policy"])
  })
})
