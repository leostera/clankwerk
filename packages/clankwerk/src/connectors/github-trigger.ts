import { Id } from "../graph/id.js"
import { Triggers } from "../graph/trigger.js"

const encoder = new TextEncoder()
const sha = /^[a-f0-9]{40}$/
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** GitHub signs the exact request bytes; this decoder is shared across instances. */
export async function verifyGitHubSignature(
  bytes: Uint8Array,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!/^sha256=[a-f0-9]{64}$/.test(header ?? "") || !secret) return false
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ])
  const signature = new Uint8Array(
    header!
      .slice(7)
      .match(/../g)!
      .map((value) => parseInt(value, 16)),
  )
  return crypto.subtle.verify("HMAC", key, signature, new Uint8Array(bytes).buffer)
}

async function limitedBody(request: Request, maximum: number): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error("Missing GitHub webhook body")
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) {
      await reader.cancel()
      throw new Error("GitHub webhook exceeds size limit")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export interface GitHubTriggerOptions {
  /** Secret stays in the host binding, never a manifest or persisted trigger value. */
  secret: string
  repository: string
  path: string
  maxBytes?: number
  /** If set, only pushes to this base branch activate the push trigger. */
  baseBranch?: string
}

export type GitHubIssueEvent = {
  deliveryId: string
  action: "opened" | "reopened"
  repository: string
  number: number
  title: string
  body: string
  url: string
  author: string
}
export type GitHubPullEvent = { repository: string; number: number; head: string; deliveryId: string }
export type GitHubPushEvent = { repository: string; branch: string; head: string; deliveryId: string }
export type GitHubReviewEvent = GitHubPullEvent & { reviewId: number; body: string }
export type GitHubCommentEvent = {
  repository: string
  number: number
  commentId: number
  body: string
  author: string
  deliveryId: string
}

/** Declare signed, keyed GitHub triggers; no HTTP handler or workflow transition is instance-specific. */
export function githubTriggers(options: GitHubTriggerOptions) {
  const { secret, repository, path, maxBytes = 1_048_576, baseBranch } = options
  if (
    !/^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/.test(repository) ||
    !path.startsWith("/") ||
    (baseBranch !== undefined && !/^[a-zA-Z0-9._/-]{1,100}$/.test(baseBranch))
  )
    throw new Error("Invalid GitHub trigger configuration")
  const namespace = repository.replace("/", ":")
  const verify = async (request: Request) => {
    if (!secret || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
      throw new Error("GitHub webhook is not configured for JSON")
    const bytes = await limitedBody(request, maxBytes)
    if (!(await verifyGitHubSignature(bytes, request.headers.get("x-hub-signature-256"), secret)))
      throw new Error("Invalid GitHub webhook signature")
  }
  const payload = async (request: Request) => {
    const delivery = request.headers.get("x-github-delivery")
    if (!delivery || !/^[a-f0-9-]{36}$/i.test(delivery)) throw new Error("Invalid GitHub delivery ID")
    const data = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await limitedBody(request, maxBytes))),
    )
    if (!data) throw new Error("Invalid GitHub payload")
    const repo = object(data.repository)
    if (
      repo?.full_name !== repository ||
      object(repo.owner)?.login !== repository.split("/")[0] ||
      repo.name !== repository.split("/")[1]
    )
      throw new Error("GitHub repository mismatch")
    return { event: request.headers.get("x-github-event"), delivery, data }
  }
  const issue = Triggers.webhook<GitHubIssueEvent>({
    id: Id.trigger("github-issue-opened"),
    path,
    verify,
    key: (value) =>
      `${namespace}:issue:${value.number}:${value.action}${value.action === "reopened" ? `:${value.deliveryId}` : ""}`,
    decode: async (request) => {
      const { event, delivery, data } = await payload(request)
      if (event !== "issues" || (data.action !== "opened" && data.action !== "reopened")) return undefined
      const issue = object(data.issue)
      const number = issue?.number
      const author = object(issue?.user)?.login
      if (
        !issue ||
        !Number.isSafeInteger(number) ||
        (number as number) < 1 ||
        issue.pull_request ||
        typeof author !== "string" ||
        typeof issue.title !== "string" ||
        (typeof issue.body !== "string" && issue.body !== null) ||
        issue.html_url !== `https://github.com/${repository}/issues/${number}`
      )
        throw new Error("Invalid GitHub issue")
      return {
        deliveryId: delivery,
        action: data.action as "opened" | "reopened",
        repository,
        number: number as number,
        title: issue.title.slice(0, 1_000),
        body: (issue.body ?? "").slice(0, 32_000),
        author,
        url: issue.html_url,
      } as GitHubIssueEvent
    },
  })
  const push = Triggers.webhook<GitHubPushEvent>({
    id: Id.trigger("github-branch-push"),
    path,
    verify,
    key: (value) => `${namespace}:push:${value.branch}:${value.head}:${value.deliveryId}`,
    decode: async (request) => {
      const { event, delivery, data } = await payload(request)
      if (
        event !== "push" ||
        data.deleted === true ||
        typeof data.ref !== "string" ||
        !data.ref.startsWith("refs/heads/")
      )
        return undefined
      const branch = data.ref.slice("refs/heads/".length)
      if (baseBranch !== undefined && branch !== baseBranch) return undefined
      if (!/^[a-zA-Z0-9._/-]{1,100}$/.test(branch) || !sha.test(String(data.after)))
        throw new Error("Invalid GitHub branch push")
      return { repository, branch, head: data.after as string, deliveryId: delivery }
    },
  })
  const pull = Triggers.webhook<GitHubPullEvent>({
    id: Id.trigger("github-pr-head"),
    path,
    verify,
    key: (value) => `${namespace}:pr:${value.number}:${value.head}`,
    decode: async (request) => {
      const { event, delivery, data } = await payload(request)
      if (event !== "pull_request" || !["opened", "reopened", "synchronize"].includes(String(data.action)))
        return undefined
      const pr = object(data.pull_request)
      const number = pr?.number
      const head = object(pr?.head)?.sha
      if (
        !Number.isSafeInteger(number) ||
        (number as number) < 1 ||
        !sha.test(String(head)) ||
        pr?.html_url !== `https://github.com/${repository}/pull/${number}`
      )
        throw new Error("Invalid GitHub PR")
      return { repository, number: number as number, head: head as string, deliveryId: delivery }
    },
  })
  const review = Triggers.webhook<GitHubReviewEvent>({
    id: Id.trigger("github-pr-review"),
    path,
    verify,
    key: (value) => `${namespace}:review:${value.number}:${value.reviewId}`,
    decode: async (request) => {
      const { event, delivery, data } = await payload(request)
      if (event !== "pull_request_review" || data.action !== "submitted") return undefined
      const pr = object(data.pull_request)
      const review = object(data.review)
      const number = pr?.number
      const head = review?.commit_id
      if (
        !Number.isSafeInteger(number) ||
        (number as number) < 1 ||
        !sha.test(String(head)) ||
        !Number.isSafeInteger(review?.id) ||
        (review!.id as number) < 1 ||
        typeof review?.body !== "string"
      )
        throw new Error("Invalid GitHub review")
      return {
        repository,
        number: number as number,
        head: head as string,
        reviewId: review!.id as number,
        body: review.body,
        deliveryId: delivery,
      }
    },
  })
  const comment = Triggers.webhook<GitHubCommentEvent>({
    id: Id.trigger("github-pr-comment"),
    path,
    verify,
    key: (value) => `${namespace}:comment:${value.number}:${value.commentId}`,
    decode: async (request) => {
      const { event, delivery, data } = await payload(request)
      if (event !== "issue_comment" || data.action !== "created") return undefined
      const issue = object(data.issue)
      const comment = object(data.comment)
      const number = issue?.number
      if (
        !issue?.pull_request ||
        !Number.isSafeInteger(number) ||
        (number as number) < 1 ||
        !Number.isSafeInteger(comment?.id) ||
        (comment!.id as number) < 1 ||
        typeof object(comment?.user)?.login !== "string" ||
        typeof comment?.body !== "string"
      )
        return undefined
      return {
        repository,
        number: number as number,
        commentId: comment!.id as number,
        body: comment.body.slice(0, 4_000),
        author: object(comment.user)!.login as string,
        deliveryId: delivery,
      }
    },
  })
  return { issue, pull, review, comment, push }
}
