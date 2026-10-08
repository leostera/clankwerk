import type { SignedGitHubRepository } from "./github-app-event.js"

const slug = /^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/
const branch = /^[a-zA-Z0-9._/-]{1,100}$/
const workflow = /^[a-z][a-z0-9-]{0,79}$/
const positive = (value: number) => Number.isSafeInteger(value) && value > 0

export type VerifiedInstallation = { id: number; fullName: string; installationId: number; base: string }
export type RepositoryPolicy = VerifiedInstallation & {
  revision: number
  enabled: boolean
  workflows: string[]
  /** Instance policy for old-issue cutoffs; new repositories can start with issue #1. */
  minimumIssue: number
  requiredLabel?: string
}
export interface RepositoryPolicyStore {
  read(): Promise<RepositoryPolicy | undefined>
  compareAndWrite(expectedRevision: number, next: RepositoryPolicy): Promise<boolean>
}

/** Store this adapter in a DO named by the immutable GitHub repository ID, never the mutable slug. */
export function durableRepositoryPolicyStore(storage: DurableObjectStorage): RepositoryPolicyStore {
  return {
    read: () => storage.get<RepositoryPolicy>("repository-policy"),
    compareAndWrite: (expectedRevision, next) =>
      storage.transaction(async (tx) => {
        const current = await tx.get<RepositoryPolicy>("repository-policy")
        if ((current?.revision ?? 0) !== expectedRevision || next.revision !== expectedRevision + 1) return false
        if (current && current.id !== next.id) throw new Error("Repository ID cannot change")
        await tx.put("repository-policy", next)
        return true
      }),
  }
}

/** Only the trusted admin host may call this with an installation verified using GitHub's App API. */
export async function enableRepository(
  store: RepositoryPolicyStore,
  verified: VerifiedInstallation,
  selected: { workflows: string[]; minimumIssue?: number; requiredLabel?: string },
  expectedRevision: number,
  allowedWorkflows: readonly string[],
): Promise<RepositoryPolicy> {
  if (
    !positive(verified.id) ||
    !positive(verified.installationId) ||
    !slug.test(verified.fullName) ||
    !branch.test(verified.base) ||
    verified.base.includes("..") ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !selected.workflows.length ||
    new Set(selected.workflows).size !== selected.workflows.length ||
    selected.workflows.some((id) => !workflow.test(id) || !allowedWorkflows.includes(id)) ||
    !Number.isSafeInteger(selected.minimumIssue ?? 1) ||
    (selected.minimumIssue ?? 1) < 1 ||
    (selected.requiredLabel !== undefined && !/^[a-zA-Z0-9._ -]{1,80}$/.test(selected.requiredLabel))
  )
    throw new Error("Invalid repository policy")
  const current = await store.read()
  if (current && current.id !== verified.id) throw new Error("Repository ID cannot change")
  const next: RepositoryPolicy = {
    ...verified,
    fullName: verified.fullName.toLowerCase(),
    revision: expectedRevision + 1,
    enabled: true,
    workflows: [...selected.workflows],
    minimumIssue: selected.minimumIssue ?? 1,
    ...(selected.requiredLabel ? { requiredLabel: selected.requiredLabel } : {}),
  }
  if (!(await store.compareAndWrite(expectedRevision, next))) throw new Error("Repository policy revision conflict")
  return next
}

export async function disableRepository(
  store: RepositoryPolicyStore,
  expectedRevision: number,
): Promise<RepositoryPolicy> {
  const current = await store.read()
  if (!current || current.revision !== expectedRevision) throw new Error("Repository policy revision conflict")
  const next = { ...current, enabled: false, revision: current.revision + 1 }
  if (!(await store.compareAndWrite(expectedRevision, next))) throw new Error("Repository policy revision conflict")
  return next
}

/** Call at admission and again immediately before trusted GitHub effects. No positive caching across runs. */
export function repositoryPermits(
  policy: RepositoryPolicy | undefined,
  repository: SignedGitHubRepository & { installationId: number },
  workflowId: string,
  issueNumber?: number,
): boolean {
  return Boolean(
    policy?.enabled &&
    policy.id === repository.id &&
    policy.fullName === repository.fullName.toLowerCase() &&
    policy.installationId === repository.installationId &&
    policy.workflows.includes(workflowId) &&
    (issueNumber === undefined || (Number.isSafeInteger(issueNumber) && issueNumber >= policy.minimumIssue)),
  )
}
