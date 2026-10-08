import type { Octokit } from "@octokit/rest"

export type IssueScope = { owner: string; repo: string }
export type IssueCommentScope = IssueScope & {
  /** Stable per-instance marker namespace. Do not change for existing comments. */
  namespace: string
  secret: string
  bot: string
  /** Explicitly trusted historical author for an existing signed marker. */
  historicalAuthor?: string
  /** Optional legacy marker identity. Default includes the canonical owner/repo to prevent cross-repo collisions. */
  markerIdentity?: string
  /** Optional legacy receipt prefix. Default includes owner/repo even when sharing one DO. */
  receiptPrefix?: string
}
export type IssueCommentReceipt = { url?: string; pending?: boolean }
export interface IssueCommentReceiptStore {
  get(key: string): Promise<IssueCommentReceipt | undefined>
  put(key: string, receipt: IssueCommentReceipt): Promise<void>
}

const name = /^[a-zA-Z0-9-]{1,39}$/
const repoName = /^[a-zA-Z0-9._-]{1,100}$/
const commentKey = /^[a-zA-Z0-9._:-]{1,120}$/

function target(scope: IssueScope, number: number) {
  if (
    !name.test(scope.owner) ||
    !repoName.test(scope.repo) ||
    scope.repo === "." ||
    scope.repo === ".." ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error("Invalid GitHub issue target")
  return { owner: scope.owner, repo: scope.repo, issue_number: number }
}

/** A fresh issue read prevents a signed, outdated delivery from authorizing a write. */
export async function readIssueLabels(
  client: Octokit,
  scope: IssueScope,
  number: number,
  title: string,
  body: string,
): Promise<{ labels: { name: string; description: string | null }[]; current: string[] }> {
  if (title.length > 1_000 || body.length > 32_000) throw new Error("Invalid issue payload")
  const args = target(scope, number)
  const { data: issue } = await client.rest.issues.get(args)
  if (
    issue.state !== "open" ||
    "pull_request" in issue ||
    issue.title !== title ||
    (issue.body ?? "").slice(0, 32_000) !== body ||
    issue.html_url !== `https://github.com/${scope.owner}/${scope.repo}/issues/${number}`
  )
    throw new Error("Issue changed or closed since the signed webhook")
  const catalog = await client.paginate(client.rest.issues.listLabelsForRepo, {
    owner: scope.owner,
    repo: scope.repo,
    per_page: 100,
  })
  if (catalog.length > 100) throw new Error("Too many repository labels")
  return {
    labels: catalog.map((label) => ({ name: label.name, description: label.description ?? null })),
    current: issue.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => typeof label === "string"),
  }
}

export async function ensureIssueLabel(
  client: Octokit,
  scope: IssueScope,
  input: {
    number: number
    title: string
    body: string
    label: string
    allowed: readonly string[]
    beforeWrite?: () => Promise<void>
  },
): Promise<{ label: string; applied: boolean }> {
  const { number, title, body, label, allowed } = input
  if (!allowed.includes(label) || !label.trim()) throw new Error("Unsupported automation label")
  const { labels, current } = await readIssueLabels(client, scope, number, title, body)
  if (!labels.some((entry) => entry.name === label)) throw new Error("Label is not configured on the repository")
  if (current.includes(label)) return { label, applied: true }
  const args = target(scope, number)
  // A read and label-catalog lookup can outlive a repository disable. Recheck at the write edge.
  await input.beforeWrite?.()
  await client.rest.issues.addLabels({ ...args, labels: [label] })
  // Reconcile an ambiguous write against the current GitHub issue, not local optimism.
  const { data: issue } = await client.rest.issues.get(args)
  if (!issue.labels.some((entry) => (typeof entry === "string" ? entry : entry.name) === label))
    throw new Error("GitHub did not persist the requested label")
  return { label, applied: true }
}

/** Signed comment marker and remote-first reconciliation survive lost acknowledgements and DO restarts. */
export async function ensureIssueComment(
  client: Octokit,
  scope: IssueCommentScope,
  receipts: IssueCommentReceiptStore,
  input: { number: number; key: string; kind: string; body: string },
): Promise<{ url: string; alreadyPosted: boolean }> {
  const { number, key, kind, body } = input
  const args = target(scope, number)
  if (
    !/^[a-zA-Z0-9-]{1,40}$/.test(scope.namespace) ||
    !/^[a-zA-Z0-9-]{1,40}$/.test(kind) ||
    !commentKey.test(key) ||
    !/^([a-zA-Z0-9-]{1,39})(?:\[bot\])?$/.test(scope.bot) ||
    !scope.secret ||
    !body.trim() ||
    body.length > 5_000
  )
    throw new Error("Invalid GitHub issue comment")
  const markerIdentity = scope.markerIdentity ?? `${scope.owner}/${scope.repo}:${scope.namespace}`
  if (
    !/^[a-zA-Z0-9._:/-]{1,200}$/.test(markerIdentity) ||
    (scope.receiptPrefix !== undefined && !/^[a-zA-Z0-9._:/-]{0,200}$/.test(scope.receiptPrefix))
  )
    throw new Error("Invalid GitHub issue comment identity")
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(scope.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(`${markerIdentity}:${number}:${key}`)),
  )
  const marker = `<!-- ${scope.namespace}-${kind}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")} -->`
  const { data: issue } = await client.rest.issues.get(args)
  if (issue.state !== "open" || "pull_request" in issue) throw new Error("Issue closed or is a pull request")
  const comments = await client.paginate(client.rest.issues.listComments, { ...args, per_page: 100 })
  if (comments.length > 100) throw new Error("Too many issue comments to reconcile")
  const existing = comments.find(
    (comment) =>
      (comment.user?.login === scope.bot ||
        (scope.historicalAuthor && comment.user?.login === scope.historicalAuthor)) &&
      comment.body?.includes(marker),
  )
  const receiptKey = `${scope.receiptPrefix ?? `${scope.owner}/${scope.repo}:`}${kind}-comment:${number}:${key}`
  if (existing) {
    await receipts.put(receiptKey, { url: existing.html_url })
    return { url: existing.html_url, alreadyPosted: true }
  }
  const receipt = await receipts.get(receiptKey)
  if (receipt?.url) return { url: receipt.url, alreadyPosted: true }
  if (receipt?.pending) throw new Error("Comment write is ambiguous; reconcile before retry")
  await receipts.put(receiptKey, { pending: true })
  const created = await client.rest.issues.createComment({ ...args, body: `${body}\n\n${marker}` })
  await receipts.put(receiptKey, { url: created.data.html_url })
  return { url: created.data.html_url, alreadyPosted: false }
}
