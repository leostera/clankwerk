import type { Octokit } from "@octokit/rest"
import type { RepositoryScope } from "./github-pull.js"

type FileChange = { path: string; content: string | null }
export type DraftChange = { issue: number; base: string; files: FileChange[]; title: string }
export type DraftResult = { branch: string; commit: string; url: string; number: number }
export interface PublicationPolicy extends RepositoryScope {
  branchForIssue(issue: number): string
  /** Optional inverse for correlating signed PR feedback with a verified issue draft. */
  issueFromBranch?(branch: string): number | null
  allowPath?(path: string): boolean
}
const sha40 = /^[a-f0-9]{40}$/
const safePath = (path: string) =>
  path.length <= 200 &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part && part !== "." && part !== "..") &&
  !/[\x00-\x1f\\]/.test(path) &&
  !/(^|\/)\.git(?:\/|$)/.test(path) &&
  !/(^|\/)\.env(?:\.|$)/.test(path) &&
  !path.startsWith(".github/workflows/")

export function issueBranch(issue: number, policy: PublicationPolicy): string {
  const { owner, repo, base } = policy
  if (
    !/^[a-zA-Z0-9-]{1,39}$/.test(owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
    !/^[a-zA-Z0-9._/-]{1,100}$/.test(base) ||
    !Number.isSafeInteger(issue) ||
    issue < 1
  )
    throw new Error("Invalid publication policy")
  const branch = policy.branchForIssue(issue)
  if (
    !branch ||
    branch.length > 150 ||
    !/^[a-zA-Z0-9._/-]+$/.test(branch) ||
    branch.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".lock")) ||
    branch === base ||
    branch.startsWith(`${base}/`)
  )
    throw new Error("Invalid issue branch policy")
  return branch
}

export function validateDraft(change: DraftChange, policy: PublicationPolicy): string {
  const branch = issueBranch(change.issue, policy)
  if (
    !Number.isSafeInteger(change.issue) ||
    change.issue < 1 ||
    !sha40.test(change.base) ||
    typeof change.title !== "string" ||
    !change.title.trim() ||
    change.title.length > 200 ||
    /[\x00-\x1f]/.test(change.title) ||
    !Array.isArray(change.files) ||
    !change.files.length ||
    change.files.length > 12
  )
    throw new Error("Invalid issue, base, title or file count")
  let size = 0
  const names = new Set<string>()
  for (const file of change.files) {
    if (
      typeof file.path !== "string" ||
      !safePath(file.path) ||
      (policy.allowPath && !policy.allowPath(file.path)) ||
      names.has(file.path) ||
      (file.content !== null && typeof file.content !== "string")
    )
      throw new Error("Invalid changed file")
    names.add(file.path)
    if (file.content !== null) size += new TextEncoder().encode(file.content).byteLength
  }
  if (size > 100_000) throw new Error("Draft exceeds 100KB text limit")
  return branch
}

/** A trusted Worker uses Octokit's authenticated Git Data and Pull Requests APIs.
 * The sandbox never receives this client, its token, or a GitHub write capability. */
export async function publishDraft(
  change: DraftChange,
  octokit: Octokit,
  policy: PublicationPolicy,
): Promise<DraftResult> {
  const branch = validateDraft(change, policy)
  const { owner, repo, base } = policy
  const { data: main } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
  if (main.object.sha !== change.base) throw new Error("Main moved; regenerate the diff from the new base")
  let existingSha: string | null = null
  try {
    existingSha = (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha
  } catch (error) {
    if (!(error instanceof Error && "status" in error && error.status === 404)) throw error
  }
  const { data: baseCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: change.base })
  if (!sha40.test(baseCommit.tree.sha)) throw new Error("Invalid base tree")
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = []
  for (const file of change.files) {
    const sha =
      file.content === null
        ? null
        : (
            await octokit.rest.git.createBlob({
              owner,
              repo,
              content: file.content,
              encoding: "utf-8",
            })
          ).data.sha
    if (sha !== null && !sha40.test(sha)) throw new Error("Invalid GitHub blob")
    entries.push({ path: file.path, mode: "100644", type: "blob", sha })
  }
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: entries,
  })
  if (!sha40.test(tree.sha)) throw new Error("Invalid GitHub tree")
  const message = `Work on #${change.issue}: ${change.title}`
  let commitSha: string
  if (existingSha) {
    const { data: existingCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: existingSha })
    if (
      !sha40.test(existingSha) ||
      existingCommit.tree.sha !== tree.sha ||
      existingCommit.parents.length !== 1 ||
      existingCommit.parents[0]?.sha !== change.base ||
      existingCommit.message !== message
    )
      throw new Error("Issue branch has a different commit; refuse to overwrite")
    commitSha = existingSha
  } else {
    const { data: commit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: tree.sha,
      parents: [change.base],
    })
    if (!sha40.test(commit.sha)) throw new Error("Invalid GitHub commit")
    commitSha = commit.sha
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commitSha })
  }
  const { data: pulls } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "all",
    per_page: 10,
  })
  const existingPull = pulls.find((item) => item.head.sha === commitSha && item.base.ref === base)
  const pull =
    existingPull ??
    (
      await octokit.rest.pulls.create({
        owner,
        repo,
        head: branch,
        base,
        draft: true,
        title: change.title,
        body: `Automated draft for #${change.issue}. Independent review may request revisions.\n\nCloses #${change.issue}`,
      })
    ).data
  if (pull.html_url !== `https://github.com/${owner}/${repo}/pull/${pull.number}`)
    throw new Error("Invalid draft PR response")
  return { branch, commit: commitSha, url: pull.html_url, number: pull.number }
}

/** Fast-forward only the issue's existing draft branch, anchored to the reviewed PR head. */
export async function reviseDraft(
  change: DraftChange,
  previous: DraftResult,
  octokit: Octokit,
  policy: PublicationPolicy,
  priorBase = change.base,
): Promise<DraftResult> {
  const branch = validateDraft(change, policy)
  const { owner, repo, base } = policy
  if (
    previous.branch !== branch ||
    !sha40.test(previous.commit) ||
    !sha40.test(priorBase) ||
    !Number.isSafeInteger(previous.number) ||
    previous.number < 1 ||
    previous.url !== `https://github.com/${owner}/${repo}/pull/${previous.number}`
  )
    throw new Error("Invalid prior draft")
  const { data: main } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
  if (main.object.sha !== change.base) throw new Error("Base moved; stop and rebase the issue")
  const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: previous.number })
  if (
    pull.state !== "open" ||
    !pull.draft ||
    pull.base.ref !== base ||
    pull.head.repo?.full_name !== `${owner}/${repo}` ||
    pull.head.ref !== branch
  )
    throw new Error("The expected draft PR is no longer open")
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
  if (ref.object.sha !== pull.head.sha) throw new Error("PR head changed during publication")
  const { data: baseCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: change.base })
  if (!sha40.test(baseCommit.tree.sha)) throw new Error("Invalid base tree")
  const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = []
  for (const file of change.files) {
    const sha =
      file.content === null
        ? null
        : (
            await octokit.rest.git.createBlob({
              owner,
              repo,
              content: file.content,
              encoding: "utf-8",
            })
          ).data.sha
    if (sha !== null && !sha40.test(sha)) throw new Error("Invalid blob")
    entries.push({ path: file.path, mode: "100644", type: "blob", sha })
  }
  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: entries,
  })
  if (!sha40.test(tree.sha)) throw new Error("Invalid revision tree")
  const message = `Revise #${change.issue}: ${change.title}`
  const parents = priorBase === change.base ? [previous.commit] : [previous.commit, change.base]
  if (ref.object.sha !== previous.commit) {
    // An earlier attempt may have fast-forwarded before its acknowledgement was stored.
    const { data: existing } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: ref.object.sha })
    if (
      existing.tree.sha !== tree.sha ||
      existing.parents.length !== parents.length ||
      existing.parents.some((parent, index) => parent.sha !== parents[index]) ||
      existing.message !== message
    )
      throw new Error("Draft branch advanced independently; refuse to overwrite")
    return { ...previous, commit: ref.object.sha }
  }
  const { data: headCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: previous.commit })
  if (headCommit.tree.sha === tree.sha && priorBase === change.base) return previous
  const { data: commit } = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.sha, parents })
  if (!sha40.test(commit.sha)) throw new Error("Invalid revision commit")
  const { data: updated } = await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  })
  if (updated.object.sha !== commit.sha) throw new Error("GitHub did not advance the draft")
  return { ...previous, commit: commit.sha }
}
