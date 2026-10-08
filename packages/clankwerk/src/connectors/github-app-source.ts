import { Id } from "../graph/id.js"
import { Triggers } from "../graph/trigger.js"
import type { WorkflowSource } from "../runtime/scheduler.js"
import { keyedWebhookActivation, type WebhookActivation } from "../runtime/webhook.js"
import { readSignedGitHubEvent, type SignedGitHubEvent, type SignedGitHubRepository } from "./github-app-event.js"
import { repositoryPermits, type RepositoryPolicy, type VerifiedInstallation } from "./github-repository-policy.js"

const unavailable = () => {
  throw new Error("App webhook requires source-level signature and policy admission")
}
const appIssueId = Id.trigger("github-app-issue")
const appPullId = Id.trigger("github-app-pull")

/** Repo-independent graph nodes; the generic per-trigger dispatcher fails closed on these source-only triggers. */
export function githubAppTriggers(path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub App hook path")
  return {
    issue: Triggers.webhook<SignedGitHubEvent & { kind: "issue" }>({
      id: appIssueId,
      path,
      verify: unavailable,
      decode: unavailable,
      key: (event) => `repo:${event.repository.id}:issue:${event.number}`,
    }),
    pull: Triggers.webhook<SignedGitHubEvent & { kind: "pull" }>({
      id: appPullId,
      path,
      verify: unavailable,
      decode: unavailable,
      key: (event) => `repo:${event.repository.id}:pr:${event.number}:${event.head}`,
    }),
  }
}

export type GitHubAppSourceOptions = {
  path: string
  secret: string
  workflows: { issue: WorkflowSource; pull: WorkflowSource }
  /** The host looks up the per-ID authoritative DO, not a query projection. */
  policy: (repositoryId: number) => Promise<RepositoryPolicy | undefined>
  /** Verify current installation and canonical identity using GitHub App credentials, including legacy hooks. */
  installation: (signed: SignedGitHubRepository) => Promise<VerifiedInstallation>
  /** The host must durably reconcile delivery UUID/body digest and logical event key before acknowledging. */
  activate: (event: WebhookActivation, delivery: { id: string; digest: string }) => Promise<unknown>
}

/** Authenticate once, then admit only workflows selected by the verified repository's current policy. */
export async function dispatchGitHubApp(
  request: Request,
  options: GitHubAppSourceOptions,
): Promise<WebhookActivation[]> {
  if (new URL(request.url).pathname !== options.path) return []
  const event = await readSignedGitHubEvent(request, options.secret)
  if (!event) return []
  const verified = await options.installation(event.repository)
  if (
    verified.id !== event.repository.id ||
    verified.fullName.toLowerCase() !== event.repository.fullName ||
    (event.repository.installationId !== undefined && verified.installationId !== event.repository.installationId)
  )
    throw new Error("GitHub installation or repository changed")
  const policy = await options.policy(verified.id)
  const repo = { ...event.repository, installationId: verified.installationId }
  const workflow = event.kind === "issue" ? options.workflows.issue : options.workflows.pull
  if (!repositoryPermits(policy, repo, workflow.id, event.kind === "issue" ? event.number : undefined)) return []
  if (policy?.base !== verified.base) throw new Error("GitHub base branch changed")
  const id = event.kind === "issue" ? appIssueId : appPullId
  const trigger = workflow.graph.triggers.find(
    (value) => value.kind === "webhook" && value.id === id && value.path === options.path,
  )
  if (!trigger || !trigger.key) throw new Error("Workflow has not declared the authenticated GitHub App source")
  const value = { ...event, repository: repo, policyRevision: policy.revision }
  const activation = await keyedWebhookActivation(workflow, trigger, value)
  await options.activate(activation, { id: event.deliveryId, digest: event.bodyDigest })
  return [activation]
}
