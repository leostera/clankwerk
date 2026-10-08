import type { Octokit } from "@octokit/rest"
import { issueBranch, type DraftResult, type PublicationPolicy } from "./github-publish.js"
import { parseReviewVerdict, type ReviewVerdict } from "./review-verdict.js"

export type RepositoryScope = { owner: string; repo: string; base: string }
export type PullSnapshot = {
  number: number
  commit: string
  title: string
  body: string
  baseCommit: string
  headRepository: string | null
  patch: string
  files: string[]
  reviewable: boolean
}
export type OwnedDraft = {
  issue: {
    repository: string
    number: number
    title: string
    body: string
    url: string
    author: string
  }
  pull: DraftResult
  base: string
}

/** Confirm a feedback PR is an actual owned issue draft, not a fork or an editable PR-body claim. */
export async function readOwnedDraft(
  octokit: Octokit,
  policy: PublicationPolicy,
  number: number,
  commit: string,
): Promise<OwnedDraft | null> {
  const args = target(policy, number)
  if (!sha.test(commit)) throw new Error("Invalid PR head")
  const { data: pull } = await octokit.rest.pulls.get(args)
  if (
    pull.state !== "open" ||
    pull.head.sha !== commit ||
    pull.base.ref !== policy.base ||
    pull.base.repo?.full_name !== repoName(policy)
  )
    throw new Error("PR head moved or base changed")
  if (!pull.draft || pull.head.repo?.full_name !== repoName(policy)) return null
  const issueNumber = policy.issueFromBranch?.(pull.head.ref)
  if (
    !issueNumber ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1 ||
    issueBranch(issueNumber, policy) !== pull.head.ref ||
    pull.html_url !== `https://github.com/${repoName(policy)}/pull/${number}`
  )
    return null
  const { data: issue } = await octokit.rest.issues.get({
    owner: policy.owner,
    repo: policy.repo,
    issue_number: issueNumber,
  })
  if (
    issue.pull_request ||
    issue.state !== "open" ||
    issue.number !== issueNumber ||
    issue.html_url !== `https://github.com/${repoName(policy)}/issues/${issueNumber}` ||
    typeof issue.user?.login !== "string" ||
    !sha.test(pull.base.sha)
  )
    throw new Error("Owned draft issue is no longer eligible")
  return {
    issue: {
      repository: repoName(policy),
      number: issueNumber,
      title: issue.title.slice(0, 1_000),
      body: (issue.body ?? "").slice(0, 32_000),
      url: issue.html_url,
      author: issue.user.login,
    },
    pull: { branch: pull.head.ref, commit, url: pull.html_url, number },
    base: pull.base.sha,
  }
}

export type ReviewReceipt = {
  number: number
  commit: string
  attempt: number
  nonce: string
  review: ReviewVerdict
  reviewId?: number
  posting?: { token: string; until: number }
}
export interface ReviewReceiptStore {
  get(key: string): Promise<ReviewReceipt | undefined>
  /** Atomically reserve a nonce and verdict before a GitHub write. */
  reserve(key: string, receipt: ReviewReceipt): Promise<ReviewReceipt>
  /** A fenced, expiring publication claim. Undefined means a different attempt is active. */
  claim(key: string, token: string, until: number): Promise<ReviewReceipt | undefined>
  complete(key: string, receipt: ReviewReceipt, token: string): Promise<boolean>
}

const sha = /^[a-f0-9]{40}$/
const target = (scope: RepositoryScope, number: number) => {
  if (
    !/^[a-zA-Z0-9-]{1,39}$/.test(scope.owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(scope.repo) ||
    !/^[a-zA-Z0-9._/-]{1,100}$/.test(scope.base) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error("Invalid GitHub repository or pull request")
  return { owner: scope.owner, repo: scope.repo, pull_number: number }
}
const repoName = (scope: RepositoryScope) => `${scope.owner}/${scope.repo}`

/** Bound all diff bytes before sending untrusted PR content to the reviewer. */
export async function readPullSnapshot(
  octokit: Octokit,
  scope: RepositoryScope,
  number: number,
  commit: string,
): Promise<PullSnapshot> {
  if (!sha.test(commit)) throw new Error("Invalid PR head commit")
  const args = target(scope, number)
  const { data: pull } = await octokit.rest.pulls.get(args)
  if (
    pull.state !== "open" ||
    pull.head.sha !== commit ||
    pull.base.ref !== scope.base ||
    pull.base.repo?.full_name !== repoName(scope)
  )
    throw new Error("PR head moved or is outside repository scope")
  // One extra entry detects >12 files; do not paginate arbitrarily large untrusted pull requests.
  const { data: files } = await octokit.rest.pulls.listFiles({ ...args, per_page: 13, page: 1 })
  let patch = ""
  let reviewable = files.length > 0 && files.length <= 12
  for (const file of files) {
    if (typeof file.patch !== "string") reviewable = false
    const entry = `File: ${file.filename}\n${file.patch ?? "[No text patch available]"}\n`
    if (patch.length + entry.length > 32_000) reviewable = false
    patch += entry.slice(0, Math.max(0, 32_000 - patch.length))
  }
  return {
    number,
    commit,
    title: pull.title.slice(0, 500),
    body: (pull.body ?? "").slice(0, 8_000),
    baseCommit: pull.base.sha,
    headRepository: pull.head.repo?.full_name ?? null,
    patch,
    files: files.slice(0, 12).map((file) => file.filename),
    reviewable,
  }
}

/** Use a durable nonce to recover from lost GitHub acknowledgements without trusting HTML markers alone. */
export async function postCommitReview(
  octokit: Octokit,
  scope: RepositoryScope,
  receipts: ReviewReceiptStore,
  input: {
    number: number
    commit: string
    actor: string
    review: ReviewVerdict
    attempt?: number
    /** Limit publication to an instance-approved branch when used in contribution workflows. */
    head?: { repository: string; branch: string; draft: boolean }
  },
): Promise<{ url: string; reviewId: number; alreadyPosted: boolean }> {
  const args = target(scope, input.number)
  if (
    !sha.test(input.commit) ||
    !/^[a-zA-Z0-9-]{1,39}(?:\[bot\])?$/.test(input.actor) ||
    (input.attempt !== undefined && (!Number.isSafeInteger(input.attempt) || input.attempt < 0 || input.attempt > 2))
  )
    throw new Error("Invalid review target")
  const { data: pull } = await octokit.rest.pulls.get(args)
  if (
    pull.state !== "open" ||
    pull.head.sha !== input.commit ||
    pull.base.ref !== scope.base ||
    pull.base.repo?.full_name !== repoName(scope) ||
    (input.head &&
      (pull.head.repo?.full_name !== input.head.repository ||
        pull.head.ref !== input.head.branch ||
        pull.draft !== input.head.draft))
  )
    throw new Error("PR head moved or is not an allowed branch")
  const { data: files } = await octokit.rest.pulls.listFiles({ ...args, per_page: 13, page: 1 })
  if ((!files.length || files.length > 12) && input.review.verdict !== "blocked")
    throw new Error("PR diff is too large for an actionable review")
  const review = parseReviewVerdict(
    JSON.stringify(input.review),
    files.map((item) => item.filename),
  )
  const attempt = input.attempt ?? 0
  const key = `review:${repoName(scope)}:${input.number}:${input.commit}:${attempt}`
  const candidate: ReviewReceipt = {
    number: input.number,
    commit: input.commit,
    attempt,
    nonce: crypto.randomUUID(),
    review,
  }
  const reserved = await receipts.reserve(key, candidate)
  if (
    reserved.number !== input.number ||
    reserved.commit !== input.commit ||
    reserved.attempt !== attempt ||
    JSON.stringify(reserved.review) !== JSON.stringify(review) ||
    !/^[a-f0-9-]{36}$/i.test(reserved.nonce)
  )
    throw new Error("Conflicting review for this commit")
  if (reserved.reviewId) return { url: pull.html_url, reviewId: reserved.reviewId, alreadyPosted: true }
  const token = crypto.randomUUID()
  const claimed = await receipts.claim(key, token, Date.now() + 10 * 60_000)
  if (!claimed) throw new Error("Review publication is already in progress; retry")
  if (claimed.reviewId) return { url: pull.html_url, reviewId: claimed.reviewId, alreadyPosted: true }
  const marker = `<!-- clankwerk-review:${claimed.nonce}:${input.commit} -->`
  // Existing GitHub reviews can be numerous. Never rely on a user-supplied marker without the private nonce.
  for (let page = 1; page <= 11; page++) {
    const { data: existing } = await octokit.rest.pulls.listReviews({
      ...args,
      per_page: 100,
      page,
    })
    const previous = existing.find(
      (item) => item.body?.includes(marker) && item.user?.login === input.actor && item.commit_id === input.commit,
    )
    if (previous) {
      if (!(await receipts.complete(key, { ...claimed, reviewId: previous.id }, token)))
        throw new Error("Review publication lease changed")
      return {
        url: previous.html_url ?? pull.html_url,
        reviewId: previous.id,
        alreadyPosted: true,
      }
    }
    if (existing.length < 100) break
    if (page === 11) throw new Error("Review history exceeds safe recovery limit")
  }
  // GitHub forbids approving or requesting changes on a PR authored by the reviewer.
  // Its own drafts retain an honest COMMENT review; dimension checks still carry blocking verdicts.
  const selfReview = pull.user?.login?.toLowerCase() === input.actor.toLowerCase()
  const event =
    selfReview || review.verdict === "blocked"
      ? ("COMMENT" as const)
      : review.verdict === "changes_requested"
        ? ("REQUEST_CHANGES" as const)
        : ("APPROVE" as const)
  const body = `Independent review for \`${input.commit}\`: **${review.verdict.replaceAll("_", " ")}**.\n\n${review.summary}${selfReview ? "\n\nGitHub does not allow this bot to approve or request changes on its own PR; see the dimension checks." : ""}\n\n${marker}`
  const comments = review.findings.map((item) => ({
    path: item.path,
    line: item.line,
    side: "RIGHT" as const,
    body: item.comment,
  }))
  let posted
  try {
    posted = (
      await octokit.rest.pulls.createReview({
        ...args,
        commit_id: input.commit,
        event,
        body,
        comments,
      })
    ).data
  } catch (error) {
    if (!(comments.length && error instanceof Error && "status" in error && error.status === 422)) throw error
    const fallback = `${body}\n\nInline placement unavailable; findings:\n${review.findings
      .map((item) => `- \`${item.path}:${item.line}\`: ${item.comment}`)
      .join("\n")}`
    posted = (
      await octokit.rest.pulls.createReview({
        ...args,
        commit_id: input.commit,
        event,
        body: fallback,
        comments: [],
      })
    ).data
  }
  if (!(await receipts.complete(key, { ...claimed, reviewId: posted.id }, token)))
    throw new Error("Review publication lease changed")
  return { url: posted.html_url ?? pull.html_url, reviewId: posted.id, alreadyPosted: false }
}

/** Only a review ID recorded by a trusted publication can drive an automated revision. */
export async function trustedCommitReview(
  receipts: ReviewReceiptStore,
  scope: RepositoryScope,
  number: number,
  commit: string,
  reviewId: number,
): Promise<ReviewVerdict | null> {
  target(scope, number)
  if (!sha.test(commit) || !Number.isSafeInteger(reviewId) || reviewId < 1) return null
  for (let attempt = 0; attempt <= 2; attempt++) {
    const receipt = await receipts.get(`review:${repoName(scope)}:${number}:${commit}:${attempt}`)
    if (receipt?.reviewId === reviewId && receipt.number === number && receipt.commit === commit) return receipt.review
  }
  return null
}
