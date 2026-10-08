import { DurableObject } from "cloudflare:workers"
import { Octokit } from "@octokit/rest"
import { signInstanceRequest } from "./github-authorization.js"
import { listInstalledRepositories, type SelectedRepository } from "./github-repositories.js"
import { fetchSelectedSnapshot } from "./github-archive.js"
import { gitReadRoute, proxyGitRead } from "./github-git-read.js"
import {
  publishDraft,
  reviseDraft,
  issueBranch,
  type DraftChange,
  type DraftResult,
  type PublicationPolicy,
} from "./github-publish.js"
import { syncDraftBranch, type BranchSync } from "./github-branch-sync.js"
import {
  postCommitReview,
  readPullSnapshot,
  readOwnedDraft,
  trustedCommitReview,
  type PullSnapshot,
  type OwnedDraft,
} from "./github-pull.js"
import type { ReviewVerdict } from "./review-verdict.js"
import { durableReviewReceipts } from "../runtime/cloudflare.js"

/** Host bindings supply scope and OAuth service location, never a sandbox credential. */
export interface GitHubConnectionEnv {
  GITHUB_ENCRYPTION_KEY: string
  CLANKWERK_INSTANCE_SECRET: string
  CLANKWERK_CONNECT: Fetcher
  GITHUB_CONNECT_ORIGIN: string
  GITHUB_INSTANCE_NAME: string
  GITHUB_OWNER: string
  GITHUB_REPO: string
  GITHUB_BASE: string
  GITHUB_BRANCH_PREFIX: string
}
export type GitHubCredential = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshExpiresAt?: number
  accountId: number
  login: string
}
type Sealed = { iv: string; data: string }
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value))

/** Reusable encrypted OAuth custody and repository-scoped GitHub capability. */
export class GitHubConnection extends DurableObject<GitHubConnectionEnv> {
  private rotation?: Promise<GitHubCredential>

  private policy(): PublicationPolicy {
    const { GITHUB_OWNER: owner, GITHUB_REPO: repo, GITHUB_BASE: base, GITHUB_BRANCH_PREFIX: prefix } = this.env
    if (
      !/^[a-zA-Z0-9._/-]{1,100}$/.test(prefix) ||
      prefix.includes("..") ||
      prefix.startsWith("/") ||
      prefix.endsWith("/")
    )
      throw new Error("Invalid GitHub branch prefix")
    const policy = {
      owner,
      repo,
      base,
      branchForIssue: (issue: number) => `${prefix}/issue-${issue}`,
      issueFromBranch: (branch: string) => {
        const suffix = branch.startsWith(`${prefix}/issue-`) ? branch.slice(`${prefix}/issue-`.length) : ""
        return /^[1-9][0-9]{0,6}$/.test(suffix) ? Number(suffix) : null
      },
    }
    issueBranch(1, policy) // Validate host configuration before any API write.
    return policy
  }

  private async key(): Promise<CryptoKey> {
    const bytes = decode(this.env.GITHUB_ENCRYPTION_KEY)
    if (bytes.length !== 32) throw new Error("Invalid GitHub connection encryption key")
    return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"])
  }

  private async read(): Promise<GitHubCredential | null> {
    const sealed = await this.ctx.storage.get<Sealed>("connection")
    if (!sealed) return null
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(sealed.iv) as BufferSource },
      await this.key(),
      decode(sealed.data) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(bytes)) as GitHubCredential
  }

  async save(credential: GitHubCredential): Promise<void> {
    if (
      !credential.accessToken?.startsWith("ghu_") ||
      !credential.refreshToken?.startsWith("ghr_") ||
      !Number.isSafeInteger(credential.accountId) ||
      !Number.isFinite(credential.expiresAt) ||
      (credential.refreshExpiresAt !== undefined && !Number.isFinite(credential.refreshExpiresAt)) ||
      typeof credential.login !== "string" ||
      !/^[a-zA-Z0-9-]{1,39}$/.test(credential.login)
    )
      throw new Error("Invalid GitHub account connection")
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const bytes = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await this.key(),
        new TextEncoder().encode(JSON.stringify(credential)),
      ),
    )
    await this.ctx.storage.put("connection", { iv: encode(iv), data: encode(bytes) })
  }

  private async current(): Promise<GitHubCredential> {
    const account = await this.read()
    if (!account) throw new Error("GitHub is not connected")
    if (Date.now() < account.expiresAt - 60_000) return account
    if (this.rotation) return this.rotation
    const pending = (async () => {
      const origin = new URL(this.env.GITHUB_CONNECT_ORIGIN)
      if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        throw new Error("Invalid OAuth service origin")
      if (!/^[a-z][a-z0-9-]{1,79}$/.test(this.env.GITHUB_INSTANCE_NAME))
        throw new Error("Invalid Clankwerk instance identity")
      const body = JSON.stringify({ instance: this.env.GITHUB_INSTANCE_NAME, refreshToken: account.refreshToken })
      const response = await this.env.CLANKWERK_CONNECT.fetch(new URL("/internal/refresh", origin).toString(), {
        method: "POST",
        headers: await signInstanceRequest(body, this.env.CLANKWERK_INSTANCE_SECRET),
        body,
      })
      if (!response.ok) throw new Error("GitHub connection expired; reconnect")
      const rotated = (await response.json()) as Partial<GitHubCredential>
      if (
        !rotated.accessToken?.startsWith("ghu_") ||
        !rotated.refreshToken?.startsWith("ghr_") ||
        typeof rotated.expiresAt !== "number" ||
        !Number.isFinite(rotated.expiresAt) ||
        rotated.expiresAt <= Date.now() + 60_000 ||
        !Number.isFinite(rotated.refreshExpiresAt)
      )
        throw new Error("Invalid GitHub token rotation")
      const latest = await this.read()
      if (!latest || latest.refreshToken !== account.refreshToken)
        throw new Error("GitHub connection changed during rotation")
      const updated: GitHubCredential = {
        ...latest,
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        expiresAt: rotated.expiresAt,
        refreshExpiresAt: rotated.refreshExpiresAt,
      }
      await this.save(updated)
      return updated
    })()
    this.rotation = pending
    try {
      return await pending
    } finally {
      if (this.rotation === pending) this.rotation = undefined
    }
  }

  async status(): Promise<{ connected: boolean; login?: string; expiresAt?: number; expired?: boolean }> {
    let account = await this.read()
    if (account && Date.now() >= account.expiresAt - 60_000) {
      try {
        account = await this.current()
      } catch {
        /* Let the host offer reconnect. */
      }
    }
    return account
      ? {
          connected: true,
          login: account.login,
          expiresAt: account.expiresAt,
          expired: Date.now() >= account.expiresAt - 30_000,
        }
      : { connected: false }
  }

  async disconnect(): Promise<void> {
    if (this.rotation) await this.rotation.catch(() => {})
    await this.ctx.storage.delete("connection")
  }

  async repositories(): Promise<SelectedRepository[]> {
    return listInstalledRepositories(new Octokit({ auth: (await this.current()).accessToken }))
  }

  private async selected(client: Octokit, repo: string): Promise<void> {
    if (!(await listInstalledRepositories(client)).some((entry) => entry.fullName === repo))
      throw new Error("Repository is not selected in the GitHub App")
  }

  async gitRead(repo: string, request: Request): Promise<Response> {
    if (!gitReadRoute(repo, request)) return new Response("Git operation not allowed", { status: 403 })
    let account: GitHubCredential
    try {
      account = await this.current()
    } catch {
      return new Response("GitHub connection expired", { status: 401 })
    }
    await this.selected(new Octokit({ auth: account.accessToken }), repo)
    return proxyGitRead(repo, account.accessToken, request)
  }

  async readOnlySnapshot(
    owner: string,
    repo: string,
  ): Promise<{
    repo: string
    branch: string
    sha: string
    archive: ArrayBuffer
  }> {
    const account = await this.current()
    return fetchSelectedSnapshot(owner, repo, new Octokit({ auth: account.accessToken }), account.accessToken)
  }

  async pullRequestPermission(): Promise<{ pullRequests: string; contents: string }> {
    const account = await this.current()
    const { data } = await new Octokit({ auth: account.accessToken }).rest.apps.listInstallationsForAuthenticatedUser({
      per_page: 100,
    })
    if (data.total_count !== 1 || data.installations.length !== 1)
      throw new Error("Cannot uniquely identify the GitHub installation")
    const permissions = data.installations[0]!.permissions
    return { pullRequests: permissions.pull_requests ?? "none", contents: permissions.contents ?? "none" }
  }

  /** Read-only, exact-head proof of issue ownership before treating a review as contribution feedback. */
  async ownedDraft(number: number, commit: string): Promise<OwnedDraft | null> {
    return readOwnedDraft(new Octokit({ auth: (await this.current()).accessToken }), this.policy(), number, commit)
  }

  async reviewSnapshot(number: number, commit: string): Promise<PullSnapshot> {
    const account = await this.current()
    return readPullSnapshot(new Octokit({ auth: account.accessToken }), this.policy(), number, commit)
  }

  async recordReview(input: {
    number: number
    commit: string
    review: ReviewVerdict
    issue?: number
    attempt?: number
  }): Promise<{ url: string; reviewId: number; alreadyPosted: boolean }> {
    const account = await this.current()
    const policy = this.policy()
    const head =
      input.issue === undefined
        ? undefined
        : {
            repository: `${policy.owner}/${policy.repo}`,
            branch: issueBranch(input.issue, policy),
            draft: true,
          }
    return postCommitReview(
      new Octokit({ auth: account.accessToken }),
      policy,
      durableReviewReceipts(this.ctx.storage),
      {
        number: input.number,
        commit: input.commit,
        review: input.review,
        actor: account.login,
        ...(head ? { head } : {}),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      },
    )
  }

  async trustedReview(number: number, commit: string, reviewId: number): Promise<ReviewVerdict | null> {
    return trustedCommitReview(durableReviewReceipts(this.ctx.storage), this.policy(), number, commit, reviewId)
  }

  async mainHead(): Promise<string> {
    const { owner, repo, base } = this.policy()
    const { data } = await new Octokit({ auth: (await this.current()).accessToken }).rest.git.getRef({
      owner,
      repo,
      ref: `heads/${base}`,
    })
    if (!/^[a-f0-9]{40}$/.test(data.object.sha)) throw new Error("Invalid base ref")
    return data.object.sha
  }

  async syncDraft(issue: number, previous: DraftResult): Promise<BranchSync> {
    const account = await this.current()
    return syncDraftBranch(issue, previous, new Octokit({ auth: account.accessToken }), this.policy())
  }

  async revise(change: DraftChange, previous: DraftResult, priorBase?: string): Promise<DraftResult> {
    const policy = this.policy()
    const account = await this.current()
    const client = new Octokit({ auth: account.accessToken })
    await this.selected(client, `${policy.owner}/${policy.repo}`)
    return reviseDraft(change, previous, client, policy, priorBase)
  }

  async publish(change: DraftChange): Promise<DraftResult> {
    const policy = this.policy()
    const account = await this.current()
    const client = new Octokit({ auth: account.accessToken })
    await this.selected(client, `${policy.owner}/${policy.repo}`)
    return publishDraft(change, client, policy)
  }
}
