import { Octokit } from "@octokit/rest"
import { issueInstallationToken } from "./github-app.js"
import { repositoryPermits, type RepositoryPolicy } from "./github-repository-policy.js"

type Permissions = Parameters<typeof issueInstallationToken>[0]["permissions"]
type RepositoryIdentity = { id: number; fullName: string; installationId: number }
export type GitHubScope = Readonly<{
  repositoryId: number
  installationId: number
  owner: string
  repo: string
  base: string
}>

/** Executed only within a trusted Worker step; do not serialize this object or pass it to an agent/sandbox. */
export interface GitHubWorkflowCapability {
  withOctokit<T>(permissions: Permissions, action: (client: Octokit, scope: GitHubScope) => Promise<T>): Promise<T>
}

export function githubWorkflowCapability(options: {
  repository: RepositoryIdentity
  workflowId: string
  /** Authoritative per-repository DO read on every invocation, never a D1 projection or cached run policy. */
  policy: () => Promise<RepositoryPolicy | undefined>
  /** Static maximum for the declared workflow, chosen by the trusted instance host. */
  allowedPermissions: Permissions
  app: Pick<Parameters<typeof issueInstallationToken>[0], "clientId" | "appId" | "privateKey">
  issueToken?: typeof issueInstallationToken
}): GitHubWorkflowCapability {
  return {
    async withOctokit<T>(permissions: Permissions, action: (client: Octokit, scope: GitHubScope) => Promise<T>) {
      const current = await options.policy()
      if (!repositoryPermits(current, options.repository, options.workflowId) || !current)
        throw new Error("Repository workflow is not enabled")
      const max = options.allowedPermissions
      if (
        !Object.keys(permissions).length ||
        Object.entries(permissions).some(([key, level]) => {
          const allowed = max[key as keyof Permissions]
          return !allowed || (allowed !== level && allowed !== "write")
        })
      )
        throw new Error("GitHub permissions not allowed by workflow")
      const [owner, repo] = current.fullName.split("/")
      if (!owner || !repo) throw new Error("Invalid repository policy")
      const issued = await (options.issueToken ?? issueInstallationToken)({
        ...options.app,
        owner,
        repo,
        repositoryId: current.id,
        permissions,
      })
      if (issued.repositoryId !== current.id || issued.installationId !== current.installationId)
        throw new Error("GitHub App installation changed")
      // A disable or rename during the App API call must not authorize a later effect.
      const latest = await options.policy()
      if (
        !repositoryPermits(latest, options.repository, options.workflowId) ||
        !latest ||
        latest.revision !== current.revision ||
        latest.base !== current.base
      )
        throw new Error("Repository policy changed before GitHub effect")
      const client = new Octokit({ auth: issued.token })
      const scope: GitHubScope = Object.freeze({
        repositoryId: latest.id,
        installationId: latest.installationId,
        owner,
        repo,
        base: latest.base,
      })
      const result = await action(client, scope)
      if (result === client || (typeof result === "string" && result.includes(issued.token)))
        throw new Error("GitHub credential cannot be returned from a workflow step")
      return result
    },
  }
}
