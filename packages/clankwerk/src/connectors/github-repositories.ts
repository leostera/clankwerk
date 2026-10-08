import type { Octokit } from "@octokit/rest"

export type SelectedRepository = { fullName: string; private: boolean }

/** Use Octokit's typed REST APIs; fail closed if the selected-installation list is truncated. */
export async function listInstalledRepositories(octokit: Octokit): Promise<SelectedRepository[]> {
  const result = (await octokit.rest.apps.listInstallationsForAuthenticatedUser({ per_page: 100 })).data
  if (result.installations.length > 20 || result.total_count > result.installations.length)
    throw new Error("Installation list incomplete; narrow access before continuing")
  const repos: SelectedRepository[] = []
  for (const installation of result.installations) {
    if (!Number.isSafeInteger(installation.id) || installation.id < 1) throw new Error("Invalid GitHub installation")
    for (let number = 1; number <= 21; number++) {
      const data = (
        await octokit.rest.apps.listInstallationReposForAuthenticatedUser({
          installation_id: installation.id,
          per_page: 100,
          page: number,
        })
      ).data
      if (data.total_count > 2_000) throw new Error("Repository list incomplete; narrow access before continuing")
      if (number === 21) {
        if (data.repositories.length) throw new Error("Repository list exceeds 2,000; narrow access before continuing")
        break
      }
      for (const repo of data.repositories) repos.push({ fullName: repo.full_name, private: repo.private })
      if (data.repositories.length < 100) break
    }
  }
  return repos
}
