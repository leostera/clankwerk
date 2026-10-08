import { createPrivateKey } from "node:crypto"
import { importPKCS8, SignJWT } from "jose"

type AppOptions = {
  clientId: string
  appId: number
  privateKey: string
  owner: string
  repo: string
  /** Pin an already enabled repository's immutable ID on every effect. */
  repositoryId?: number
  permissions: {
    issues?: "write"
    contents?: "read" | "write"
    pull_requests?: "write"
    checks?: "write"
  }
  fetch?: typeof fetch
}

/** A repository-scoped GitHub App installation token; never send it to an agent or browser. */
export async function issueInstallationToken(
  options: AppOptions,
): Promise<{ token: string; expiresAt: number; bot: string; repositoryId: number; installationId: number }> {
  const { clientId, appId, privateKey, owner, repo, permissions } = options
  if (
    !/^Iv[0-9a-zA-Z]{10,40}$/.test(clientId) ||
    !Number.isSafeInteger(appId) ||
    appId < 1 ||
    !/^[a-zA-Z0-9-]{1,39}$/.test(owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
    repo === "." ||
    repo === ".." ||
    (options.repositoryId !== undefined && (!Number.isSafeInteger(options.repositoryId) || options.repositoryId < 1)) ||
    Object.keys(permissions).length === 0
  )
    throw new Error("Invalid GitHub App or repository configuration")
  // GitHub downloads PKCS#1 RSA PEM; WebCrypto/Jose require PKCS#8. Convert in memory.
  const pkcs8 = createPrivateKey(privateKey).export({ format: "pem", type: "pkcs8" }).toString()
  const key = await importPKCS8(pkcs8, "RS256")
  const now = Math.floor(Date.now() / 1000)
  const jwt = await new SignJWT({ iss: clientId, iat: now - 30, exp: now + 8 * 60 })
    .setProtectedHeader({ alg: "RS256" })
    .sign(key)
  const call = options.fetch ?? fetch
  const request = async (path: string, bearer: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await call(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "clankwerk",
        "x-github-api-version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) throw new Error(`GitHub App request failed (${response.status})`)
    return (await response.json()) as Record<string, unknown>
  }
  const installation = await request(`/repos/${owner}/${repo}/installation`, jwt)
  if (
    installation.app_id !== appId ||
    !Number.isSafeInteger(installation.id) ||
    !(Number(installation.id) > 0) ||
    typeof installation.app_slug !== "string" ||
    !/^[a-z0-9-]{1,100}$/.test(installation.app_slug)
  )
    throw new Error("Repository is not installed on the configured GitHub App")
  const issued = await request(`/app/installations/${installation.id}/access_tokens`, jwt, {
    ...(options.repositoryId ? { repository_ids: [options.repositoryId] } : { repositories: [repo] }),
    permissions,
  })
  if (
    typeof issued.token !== "string" ||
    !issued.token.startsWith("ghs_") ||
    typeof issued.expires_at !== "string" ||
    !Number.isFinite(Date.parse(issued.expires_at)) ||
    Date.parse(issued.expires_at) <= Date.now() + 60_000 ||
    !Array.isArray(issued.repositories) ||
    issued.repositories.length !== 1 ||
    typeof (issued.repositories[0] as { full_name?: unknown }).full_name !== "string" ||
    (issued.repositories[0] as { full_name: string }).full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
    !Number.isSafeInteger((issued.repositories[0] as { id?: unknown }).id) ||
    Number((issued.repositories[0] as { id?: unknown }).id) < 1 ||
    (options.repositoryId !== undefined && (issued.repositories[0] as { id?: unknown }).id !== options.repositoryId) ||
    Object.entries(permissions).some(
      ([name, level]) => (issued.permissions as Record<string, unknown> | undefined)?.[name] !== level,
    )
  )
    throw new Error("GitHub did not issue the requested repository-scoped installation token")
  return {
    token: issued.token,
    expiresAt: Date.parse(issued.expires_at),
    bot: `${installation.app_slug}[bot]`,
    repositoryId: (issued.repositories[0] as { id: number }).id,
    installationId: installation.id as number,
  }
}
