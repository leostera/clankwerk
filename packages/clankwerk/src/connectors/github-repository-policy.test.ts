import { describe, expect, it } from "vitest"
import {
  disableRepository,
  enableRepository,
  repositoryPermits,
  type RepositoryPolicy,
  type RepositoryPolicyStore,
} from "./github-repository-policy.js"

const verified = (id: number, name: string) => ({ id, fullName: `team/${name}`, installationId: 9, base: "main" })
const store = (): RepositoryPolicyStore => {
  let value: RepositoryPolicy | undefined
  return {
    read: async () => value,
    compareAndWrite: async (expected, next) => {
      if ((value?.revision ?? 0) !== expected) return false
      value = next
      return true
    },
  }
}
const selected = { workflows: ["issue-triaging", "code-review"] }
const allowed = ["issue-triaging", "code-review"]

describe("per-repository enabled policy", () => {
  it("enables A and B independently at runtime, including issue #1, without changing a workflow definition", async () => {
    const a = store()
    const b = store()
    const first = await enableRepository(a, verified(11, "first"), selected, 0, allowed)
    const second = await enableRepository(b, verified(12, "second"), selected, 0, allowed)
    expect(first.minimumIssue).toBe(1)
    expect(
      repositoryPermits(await a.read(), { id: 11, fullName: "team/first", installationId: 9 }, "issue-triaging", 1),
    ).toBe(true)
    expect(
      repositoryPermits(await b.read(), { id: 12, fullName: "team/second", installationId: 9 }, "issue-triaging", 1),
    ).toBe(true)
    expect(
      repositoryPermits(await a.read(), { id: 12, fullName: "team/second", installationId: 9 }, "issue-triaging", 1),
    ).toBe(false)
    expect(second.revision).toBe(1)
  })

  it("fails closed on disabled, renamed, reinstalled or unconfigured repositories", async () => {
    const s = store()
    expect(
      repositoryPermits(await s.read(), { id: 11, fullName: "team/first", installationId: 9 }, "code-review"),
    ).toBe(false)
    const policy = await enableRepository(s, verified(11, "first"), selected, 0, allowed)
    for (const repo of [
      { id: 12, fullName: "team/first", installationId: 9 },
      { id: 11, fullName: "team/renamed", installationId: 9 },
      { id: 11, fullName: "team/first", installationId: 10 },
    ])
      expect(repositoryPermits(await s.read(), repo, "code-review")).toBe(false)
    expect(repositoryPermits(await s.read(), { id: 11, fullName: "team/first", installationId: 9 }, "auto-merge")).toBe(
      false,
    )
    await disableRepository(s, policy.revision)
    expect(
      repositoryPermits(await s.read(), { id: 11, fullName: "team/first", installationId: 9 }, "code-review"),
    ).toBe(false)
  })

  it("rejects stale revisions, unregistered workflows and invalid configuration", async () => {
    const s = store()
    await enableRepository(s, verified(11, "first"), selected, 0, allowed)
    await expect(enableRepository(s, verified(11, "first"), selected, 0, allowed)).rejects.toThrow("conflict")
    await expect(enableRepository(s, verified(11, "first"), { workflows: ["auto-merge"] }, 1, allowed)).rejects.toThrow(
      "Invalid",
    )
    await expect(
      enableRepository(s, verified(11, "first"), { ...selected, minimumIssue: 0 }, 1, allowed),
    ).rejects.toThrow("Invalid")
    await expect(disableRepository(s, 0)).rejects.toThrow("conflict")
  })
})
