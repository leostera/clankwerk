import { readLimitedGitHubBody, verifyGitHubSignature } from "./github-trigger.js"

const sha = /^[a-f0-9]{40}$/
const deliveryId = /^[a-f0-9-]{36}$/i
const slug = /^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

export type SignedGitHubRepository = {
  id: number
  fullName: string
  installationId?: number // A legacy repository hook does not include an App installation.
}
export type SignedGitHubEvent =
  | {
      kind: "issue"
      action: "opened" | "reopened"
      repository: SignedGitHubRepository
      number: number
      title: string
      body: string
      url: string
      author: string
      deliveryId: string
      bodyDigest: string
    }
  | {
      kind: "pull"
      action: "opened" | "reopened" | "synchronize"
      repository: SignedGitHubRepository
      number: number
      head: string
      deliveryId: string
      bodyDigest: string
    }

/** Signature verification and decoding only. A host MUST check the enabled-repository policy before activation. */
export async function readSignedGitHubEvent(
  request: Request,
  secret: string,
  maxBytes = 1_048_576,
): Promise<SignedGitHubEvent | undefined> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new Error("Invalid GitHub webhook request")
  const bytes = await readLimitedGitHubBody(request, maxBytes)
  if (!(await verifyGitHubSignature(bytes, request.headers.get("x-hub-signature-256"), secret)))
    throw new Error("Invalid GitHub webhook signature")
  const delivery = request.headers.get("x-github-delivery")
  if (!delivery || !deliveryId.test(delivery)) throw new Error("Invalid GitHub delivery ID")
  const data = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  const repo = object(data?.repository)
  const owner = object(repo?.owner)?.login
  const name = repo?.name
  const fullName = repo?.full_name
  const installation = object(data?.installation)
  if (
    !data ||
    !repo ||
    !positiveInteger(repo.id) ||
    typeof owner !== "string" ||
    typeof name !== "string" ||
    typeof fullName !== "string" ||
    !slug.test(fullName) ||
    `${owner}/${name}`.toLowerCase() !== fullName.toLowerCase() ||
    (installation !== null && !positiveInteger(installation.id))
  )
    throw new Error("Invalid GitHub repository identity")
  const repository: SignedGitHubRepository = {
    id: repo.id,
    fullName: fullName.toLowerCase(),
    ...(installation ? { installationId: installation.id as number } : {}),
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))
  const bodyDigest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
  const event = request.headers.get("x-github-event")
  if (event === "issues" && (data.action === "opened" || data.action === "reopened")) {
    const issue = object(data.issue)
    const number = issue?.number
    const author = object(issue?.user)?.login
    if (
      !positiveInteger(number) ||
      issue?.pull_request ||
      typeof issue?.title !== "string" ||
      (issue.body !== null && typeof issue.body !== "string") ||
      typeof author !== "string" ||
      issue.html_url !== `https://github.com/${fullName}/issues/${number}`
    )
      throw new Error("Invalid GitHub issue")
    return {
      kind: "issue",
      action: data.action,
      repository,
      number,
      title: issue.title.slice(0, 1_000),
      body: (issue.body ?? "").slice(0, 32_000) as string,
      url: issue.html_url,
      author,
      deliveryId: delivery,
      bodyDigest,
    }
  }
  if (event === "pull_request" && ["opened", "reopened", "synchronize"].includes(String(data.action))) {
    const pull = object(data.pull_request)
    const number = pull?.number
    const head = object(pull?.head)?.sha
    if (
      !positiveInteger(number) ||
      !sha.test(String(head)) ||
      pull?.html_url !== `https://github.com/${fullName}/pull/${number}`
    )
      throw new Error("Invalid GitHub pull request")
    return {
      kind: "pull",
      action: data.action as "opened" | "reopened" | "synchronize",
      repository,
      number,
      head: head as string,
      deliveryId: delivery,
      bodyDigest,
    }
  }
  return undefined
}
