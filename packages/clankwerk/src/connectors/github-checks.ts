import type { Octokit } from "@octokit/rest"
import type { ReviewVerdict } from "./review-verdict.js"

export type GitHubCheckScope = {
  owner: string
  repo: string
  base: string
  appId: number
  /** A stable, non-secret namespace for retry reconciliation. Do not change after deploying a check. */
  externalIdPrefix: string
  /** Human-facing name, e.g. `R4`; defaults to the repository name. */
  namePrefix?: string
}

export const checkConclusion = (verdict: ReviewVerdict["verdict"]) =>
  verdict === "looks_good"
    ? ("success" as const)
    : verdict === "changes_requested"
      ? ("failure" as const)
      : ("action_required" as const)

/** Recheck the live PR head before each Check Run write. Recover ambiguous writes by app and external ID. */
export async function upsertCommitCheck(
  client: Octokit,
  scope: GitHubCheckScope,
  number: number,
  head: string,
  check: string,
  verdict?: ReviewVerdict,
): Promise<{ id?: number; stale: boolean }> {
  const { owner, repo, base, appId, externalIdPrefix, namePrefix = repo } = scope
  if (
    !/^[a-zA-Z0-9-]{1,39}$/.test(owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
    !/^[a-zA-Z0-9._/-]{1,100}$/.test(base) ||
    !/^[a-zA-Z0-9._:-]{1,80}$/.test(externalIdPrefix) ||
    !/^[a-zA-Z0-9 -]{1,60}$/.test(namePrefix) ||
    !/^[a-z][a-z0-9-]{1,40}$/.test(check) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f0-9]{40}$/.test(head) ||
    !Number.isSafeInteger(appId) ||
    appId < 1
  )
    throw new Error("Invalid GitHub check target")
  const args = { owner, repo, pull_number: number }
  const { data: pull } = await client.rest.pulls.get(args)
  if (
    pull.state !== "open" ||
    pull.head.sha !== head ||
    pull.base.ref !== base ||
    pull.base.repo?.full_name !== `${owner}/${repo}`
  )
    return { stale: true }
  const name = `${namePrefix} / ${check}`
  const external_id = `${externalIdPrefix}:pr-${number}:${head}:${check}:v1`
  const { data: existing } = await client.rest.checks.listForRef({
    owner,
    repo,
    ref: head,
    check_name: name,
    per_page: 100,
  })
  if (existing.total_count > 100) throw new Error("Too many GitHub checks to reconcile safely")
  const run = existing.check_runs.find((item) => item.external_id === external_id && item.app?.id === appId)
  const output = verdict && {
    title: `${check}: ${verdict.verdict.replaceAll("_", " ")}`.slice(0, 255),
    summary: verdict.summary.slice(0, 2_000) || "No evidence available.",
    text:
      verdict.findings
        .map((finding) => `- ${finding.path}:${finding.line}: ${finding.comment}`)
        .join("\n")
        .slice(0, 12_000) || undefined,
  }
  if (run) {
    if (verdict && run.status !== "completed")
      await client.rest.checks.update({
        owner,
        repo,
        check_run_id: run.id,
        status: "completed",
        conclusion: checkConclusion(verdict.verdict),
        output: output!,
      })
    return { id: run.id, stale: false }
  }
  const created = await client.rest.checks.create({
    owner,
    repo,
    head_sha: head,
    name,
    external_id,
    status: verdict ? "completed" : "in_progress",
    ...(verdict ? { conclusion: checkConclusion(verdict.verdict), output: output! } : {}),
  })
  return { id: created.data.id, stale: false }
}
