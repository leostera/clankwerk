import { expect, test, vi } from "vitest"
import type { Octokit } from "@octokit/rest"
import {
  postCommitReview,
  readPullSnapshot,
  readOwnedDraft,
  trustedCommitReview,
  type ReviewReceipt,
  type ReviewReceiptStore,
} from "./github-pull.js"

const scope = { owner: "leostera", repo: "r4", base: "main" }
const head = "a".repeat(40)
const review = {
  verdict: "changes_requested" as const,
  summary: "Fix this",
  findings: [{ path: "README.md", line: 2, comment: "Incorrect example" }],
}
function fixture(beforePost?: () => Promise<void>, actor = "leostera", author = actor) {
  const receipts = new Map<string, ReviewReceipt>()
  const store: ReviewReceiptStore = {
    get: async (key) => receipts.get(key),
    reserve: async (key, candidate) => {
      if (!receipts.has(key)) receipts.set(key, candidate)
      return receipts.get(key)!
    },
    claim: async (key, token, until) => {
      const value = receipts.get(key)!
      if (value.reviewId) return value
      if (value.posting && value.posting.until > Date.now()) return undefined
      const claimed = { ...value, posting: { token, until } }
      receipts.set(key, claimed)
      return claimed
    },
    complete: async (key, receipt, token) => {
      if (receipts.get(key)?.posting?.token !== token) return false
      receipts.set(key, { ...receipt, posting: undefined })
      return true
    },
  }
  let pullHead = head
  let posted = 0
  const events: string[] = []
  const reviews: {
    id: number
    body: string
    user: { login: string }
    commit_id: string
    html_url: string
  }[] = []
  const client = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            state: "open",
            head: { sha: pullHead, repo: { full_name: "leostera/r4" }, ref: "r4/issue-4" },
            base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "leostera/r4" } },
            draft: true,
            user: { login: author },
            title: "Fix",
            body: "Closes #4",
            html_url: "https://github.com/leostera/r4/pull/5",
          },
        }),
        listFiles: async () => ({
          data: [{ filename: "README.md", patch: "@@ -1 +1 @@\n+example" }],
        }),
        listReviews: async () => ({ data: reviews }),
        createReview: async (params: { body: string; commit_id: string; event: string }) => {
          await beforePost?.()
          posted++
          events.push(params.event)
          const result = {
            id: posted,
            body: params.body,
            user: { login: actor },
            commit_id: params.commit_id,
            html_url: `https://github.com/leostera/r4/pull/5#review-${posted}`,
          }
          reviews.push(result)
          return { data: result }
        },
      },
    },
  } as unknown as Octokit
  return {
    client,
    store,
    receipts,
    reviews,
    events,
    count: () => posted,
    setHead: (value: string) => {
      pullHead = value
    },
  }
}

test("only a verified, current owned draft resolves feedback to an actual issue", async () => {
  const branch = { ref: "r4/issue-4", repo: { full_name: "leostera/r4" }, sha: head }
  const pull = {
    state: "open",
    head: branch,
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "leostera/r4" } },
    draft: true,
    html_url: "https://github.com/leostera/r4/pull/5",
    body: "Closes #999",
  }
  const issue = {
    number: 4,
    state: "open",
    title: "Fix",
    body: "Issue text",
    user: { login: "leostera" },
    html_url: "https://github.com/leostera/r4/issues/4",
  }
  const getIssue = vi.fn(async () => ({ data: issue }))
  const client = {
    rest: { pulls: { get: async () => ({ data: pull }) }, issues: { get: getIssue } },
  } as unknown as Octokit
  const policy = {
    ...scope,
    branchForIssue: (number: number) => `r4/issue-${number}`,
    issueFromBranch: (value: string) => (/^r4\/issue-[1-9][0-9]*$/.test(value) ? Number(value.slice(9)) : null),
  }
  expect(await readOwnedDraft(client, policy, 5, head)).toMatchObject({
    issue: { number: 4, author: "leostera" },
    pull: { commit: head, branch: "r4/issue-4" },
  })
  expect(getIssue).toHaveBeenCalledTimes(1)
  branch.repo.full_name = "a-fork/r4"
  expect(await readOwnedDraft(client, policy, 5, head)).toBeNull()
  branch.repo.full_name = "leostera/r4"
  branch.sha = "c".repeat(40)
  await expect(readOwnedDraft(client, policy, 5, head)).rejects.toThrow("head moved")
  expect(getIssue).toHaveBeenCalledTimes(1)
})

test("review snapshot is commit-bound and bounded to a scoped repo", async () => {
  const env = fixture()
  expect(await readPullSnapshot(env.client, scope, 5, head)).toMatchObject({
    number: 5,
    commit: head,
    reviewable: true,
    files: ["README.md"],
  })
  env.setHead("c".repeat(40))
  await expect(readPullSnapshot(env.client, scope, 5, head)).rejects.toThrow("head moved")
})

test("GitHub App bot reviews reconcile against the bot identity, not a human login", async () => {
  const env = fixture(undefined, "leo-r4[bot]")
  const input = { number: 5, commit: head, actor: "leo-r4[bot]", review }
  expect((await postCommitReview(env.client, scope, env.store, input)).reviewId).toBe(1)
  expect(await postCommitReview(env.client, scope, env.store, input)).toMatchObject({
    reviewId: 1,
    alreadyPosted: true,
  })
  expect(env.count()).toBe(1)
})

test("formal change requests and approvals apply only to PRs authored by someone else", async () => {
  const changes = fixture(undefined, "leo-r4[bot]", "leostera")
  await postCommitReview(changes.client, scope, changes.store, {
    number: 5,
    commit: head,
    actor: "leo-r4[bot]",
    review,
  })
  expect(changes.events).toEqual(["REQUEST_CHANGES"])
  const blockedWithFinding = fixture(undefined, "leo-r4[bot]", "leostera")
  await postCommitReview(blockedWithFinding.client, scope, blockedWithFinding.store, {
    number: 5,
    commit: head,
    actor: "leo-r4[bot]",
    review: { ...review, verdict: "blocked" },
  })
  expect(blockedWithFinding.events).toEqual(["REQUEST_CHANGES"])
  const approved = fixture(undefined, "leo-r4[bot]", "leostera")
  await postCommitReview(approved.client, scope, approved.store, {
    number: 5,
    commit: head,
    actor: "leo-r4[bot]",
    review: { verdict: "looks_good", summary: "All checks passed", findings: [] },
  })
  expect(approved.events).toEqual(["APPROVE"])
  const own = fixture(undefined, "leo-r4[bot]")
  await postCommitReview(own.client, scope, own.store, {
    number: 5,
    commit: head,
    actor: "leo-r4[bot]",
    review,
  })
  expect(own.events).toEqual(["COMMENT"])
})

test("posted COMMENTED reviews are idempotent and only stored review IDs drive revisions", async () => {
  const env = fixture()
  const input = {
    number: 5,
    commit: head,
    actor: "leostera",
    review,
    head: { repository: "leostera/r4", branch: "r4/issue-4", draft: true },
  }
  const first = await postCommitReview(env.client, scope, env.store, input)
  expect(first).toMatchObject({ reviewId: 1, alreadyPosted: false })
  expect(env.count()).toBe(1)
  expect(await postCommitReview(env.client, scope, env.store, input)).toMatchObject({
    reviewId: 1,
    alreadyPosted: true,
  })
  expect(env.count()).toBe(1)
  expect(await trustedCommitReview(env.store, scope, 5, head, 1)).toEqual(review)
  expect(await trustedCommitReview(env.store, scope, 5, head, 999)).toBeNull()
  await expect(
    postCommitReview(env.client, scope, env.store, {
      ...input,
      review: {
        verdict: "looks_good",
        summary: "Looks okay",
        findings: [],
      },
    }),
  ).rejects.toThrow("Conflicting review")
  env.setHead("c".repeat(40))
  await expect(postCommitReview(env.client, scope, env.store, input)).rejects.toThrow("head moved")
})

test("concurrent publication attempts use the same fenced receipt, not duplicate GitHub writes", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const env = fixture(() => gate)
  const input = { number: 5, commit: head, actor: "leostera", review }
  const first = postCommitReview(env.client, scope, env.store, input)
  for (let i = 0; ![...env.receipts.values()][0]?.posting && i < 20; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect([...env.receipts.values()][0]?.posting).toBeDefined()
  await expect(postCommitReview(env.client, scope, env.store, input)).rejects.toThrow("already in progress")
  release!()
  expect(await first).toMatchObject({ reviewId: 1, alreadyPosted: false })
  expect(env.count()).toBe(1)
})

test("a lost acknowledgement is recovered only using the pre-reserved private nonce and real actor", async () => {
  const env = fixture()
  const input = { number: 5, commit: head, actor: "leostera", review }
  await postCommitReview(env.client, scope, env.store, input)
  const key = `review:leostera/r4:5:${head}:0`
  env.receipts.set(key, { ...env.receipts.get(key)!, reviewId: undefined, posting: undefined })
  // A forged public marker cannot satisfy the receipt because the nonce is not in the signed run.
  env.reviews.unshift({
    id: 999,
    user: { login: "attacker" },
    commit_id: head,
    body: env.reviews[0]!.body,
    html_url: "https://github.com/leostera/r4/pull/5#fake",
  })
  expect(await postCommitReview(env.client, scope, env.store, input)).toMatchObject({
    reviewId: 1,
    alreadyPosted: true,
  })
  expect(env.count()).toBe(1)
})
