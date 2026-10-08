import type { WebhookActivation } from "../runtime/webhook.js"
import { repositoryPermits, type RepositoryPolicy } from "./github-repository-policy.js"
import type { SignedGitHubRepository } from "./github-app-event.js"

const uuid = /^[a-f0-9-]{36}$/i
const digest = /^[a-f0-9]{64}$/
const activationKey = /^[a-z][a-z0-9-]*:[a-f0-9]{64}$/

type DeliveryReceipt = { digest: string; key: string }
type LogicalClaim = { runId: string; workflowId: string; repositoryId: number }
export interface GitHubClaimStorage {
  transaction<T>(
    callback: (tx: {
      get<V>(key: string): Promise<V | undefined>
      put(key: string, value: RepositoryPolicy | DeliveryReceipt | LogicalClaim): Promise<void>
    }) => Promise<T>,
  ): Promise<T>
}

/** Use in a per-repository DO; policy check and event/delivery claims share one atomic transaction. */
export async function claimGitHubDelivery(
  storage: GitHubClaimStorage,
  candidate: {
    repository: SignedGitHubRepository & { installationId: number }
    issueNumber?: number
    activation: WebhookActivation
    delivery: { id: string; digest: string }
    runId: string
  },
): Promise<{ runId: string; duplicate: boolean }> {
  const { repository, issueNumber, activation, delivery, runId } = candidate
  if (
    !uuid.test(delivery.id) ||
    !digest.test(delivery.digest) ||
    !activationKey.test(activation.key) ||
    !activation.workflowId ||
    !runId ||
    !Number.isSafeInteger(repository.id) ||
    repository.id < 1
  )
    throw new Error("Invalid GitHub delivery claim")
  return storage.transaction(async (tx) => {
    const policy = await tx.get<RepositoryPolicy>("repository-policy")
    if (!repositoryPermits(policy, repository, activation.workflowId, issueNumber))
      throw new Error("Repository workflow is not enabled")
    const deliveryKey = `github-delivery:${delivery.id.toLowerCase()}`
    const logicalKey = `github-activation:${activation.key}`
    const previous = await tx.get<DeliveryReceipt>(deliveryKey)
    if (previous && (previous.digest !== delivery.digest || previous.key !== activation.key))
      throw new Error("Conflicting GitHub delivery replay")
    const claim = await tx.get<LogicalClaim>(logicalKey)
    if (claim && (claim.workflowId !== activation.workflowId || claim.repositoryId !== repository.id))
      throw new Error("Conflicting GitHub activation")
    if (!previous) await tx.put(deliveryKey, { digest: delivery.digest, key: activation.key })
    if (!claim) await tx.put(logicalKey, { runId, workflowId: activation.workflowId, repositoryId: repository.id })
    return { runId: claim?.runId ?? runId, duplicate: Boolean(claim) }
  })
}
