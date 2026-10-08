export interface CoderWorkspaceEnv {
  CODER_OWNER: string
  CODER_REPO: string
  CODER_BASE: string
}

export function coderWorkspaceSource(env: CoderWorkspaceEnv) {
  const { CODER_OWNER: owner, CODER_REPO: repo, CODER_BASE: base } = env
  if (
    !/^[a-zA-Z0-9-]{1,39}$/.test(owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
    !/^[a-zA-Z0-9._/-]{1,100}$/.test(base) ||
    base.includes("..")
  )
    throw new Error("Invalid Coder repository configuration")
  return { owner, repo, base, url: `https://github.com/${owner}/${repo}.git` }
}
