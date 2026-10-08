import type { Octokit } from "@octokit/rest"
import { issueBranch, type DraftResult, type PublicationPolicy } from "./github-publish.js"
const sha = /^[a-f0-9]{40}$/
export type BranchSync = { kind: "current" | "updated" | "conflict"; main: string; pull: DraftResult }

/** Sync main into a draft branch without force-pushing or merging the PR into main. */
export async function syncDraftBranch(
  issue: number,
  previous: DraftResult,
  octokit: Octokit,
  policy: PublicationPolicy,
): Promise<BranchSync> {
  const branch = issueBranch(issue, policy)
  const { owner, repo, base } = policy
  if (
    !sha.test(previous.commit) ||
    !Number.isSafeInteger(previous.number) ||
    previous.number < 1 ||
    previous.branch !== branch ||
    previous.url !== `https://github.com/${owner}/${repo}/pull/${previous.number}`
  )
    throw new Error("Invalid draft identity")
  const target = { owner, repo, pull_number: previous.number }
  const { data: main } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
  if (!sha.test(main.object.sha)) throw new Error("Invalid main ref")
  const read = async () => {
    const { data: pull } = await octokit.rest.pulls.get(target)
    if (
      pull.state !== "open" ||
      !pull.draft ||
      pull.base.ref !== base ||
      pull.head.repo?.full_name !== `${owner}/${repo}` ||
      pull.head.ref !== previous.branch ||
      !sha.test(pull.head.sha)
    )
      throw new Error("Expected draft PR changed or closed")
    return pull.head.sha
  }
  const currentHead = await read()
  const contains = async (base: string, head: string) => {
    const { data } = await octokit.rest.repos.compareCommits({ owner, repo, base, head })
    return data.status === "ahead" || data.status === "identical"
  }
  if (currentHead !== previous.commit) {
    const { data: headCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: currentHead })
    if (
      headCommit.parents.length !== 2 ||
      !headCommit.parents.some((parent) => parent.sha === previous.commit) ||
      !headCommit.parents.some((parent) => parent.sha === main.object.sha)
    )
      throw new Error("PR head changed outside the expected base sync")
    if (!(await contains(previous.commit, currentHead))) throw new Error("PR head changed independently")
    if (await contains(main.object.sha, currentHead))
      return { kind: "updated", main: main.object.sha, pull: { ...previous, commit: currentHead } }
    throw new Error("PR head changed but base is still stale")
  }
  if (await contains(main.object.sha, currentHead)) return { kind: "current", main: main.object.sha, pull: previous }
  try {
    await octokit.rest.pulls.updateBranch({ ...target, expected_head_sha: currentHead })
  } catch (error) {
    if (!(error instanceof Error && "status" in error && error.status === 422)) throw error
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: latest } = await octokit.rest.pulls.get(target)
      if (latest.head.sha !== currentHead) throw new Error("PR head changed during conflict detection")
      if (latest.mergeable === false) return { kind: "conflict", main: main.object.sha, pull: previous }
      if (latest.mergeable !== null) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error("GitHub could not update the draft; not a verified merge conflict")
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const head = await read()
    if (head !== currentHead) {
      const { data: headCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: head })
      if (
        headCommit.parents.length !== 2 ||
        !headCommit.parents.some((parent) => parent.sha === currentHead) ||
        !headCommit.parents.some((parent) => parent.sha === main.object.sha)
      )
        throw new Error("GitHub did not create an expected base merge commit")
      if (!(await contains(previous.commit, head)) || !(await contains(main.object.sha, head)))
        throw new Error("GitHub updated the PR to an unexpected commit")
      return { kind: "updated", main: main.object.sha, pull: { ...previous, commit: head } }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error("GitHub branch update is still pending; retry without issuing another update")
}
