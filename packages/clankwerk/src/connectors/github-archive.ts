import type { Octokit } from "@octokit/rest"
import { listInstalledRepositories } from "./github-repositories.js"

const maxArchive = 12 * 1024 * 1024
const api = "https://api.github.com"
type Requester = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Fetch a bounded, read-only source snapshot in the trusted Worker. No OAuth token is passed to Coder. */
export async function fetchSelectedSnapshot(
  owner: string,
  repo: string,
  octokit: Octokit,
  token: string,
  request: Requester = fetch,
): Promise<{ repo: string; branch: string; sha: string; archive: ArrayBuffer }> {
  if (
    !/^[a-zA-Z0-9-]{1,39}$/.test(owner) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) ||
    repo === "." ||
    repo === ".." ||
    !token
  )
    throw new Error("Expected an owner, repository name and authenticated connection")
  const fullName = `${owner}/${repo}`
  const selected = await listInstalledRepositories(octokit)
  if (!selected.some((entry) => entry.fullName === fullName))
    throw new Error("Repository is not selected in the GitHub App")
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "clankwerk-connect",
    "x-github-api-version": "2022-11-28",
  }
  const options = { headers, redirect: "manual" as const, signal: AbortSignal.timeout(30_000) }
  const details = (await octokit.rest.repos.get({ owner, repo })).data
  if (
    details.full_name !== fullName ||
    !details.default_branch ||
    details.default_branch.length > 100 ||
    !/^[a-zA-Z0-9._/-]+$/.test(details.default_branch) ||
    details.default_branch.split("/").some((part) => part === "..")
  )
    throw new Error("Invalid repository metadata")
  const branch = details.default_branch
  const { sha } = (await octokit.rest.repos.getCommit({ owner, repo, ref: branch })).data
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid repository HEAD")
  // Keep the archive's redirect and byte stream explicit: Octokit's JSON-oriented response
  // handling would buffer an unbounded private archive and follow a signed codeload URL.
  const archiveURL = `${api}/repos/${fullName}/tarball/${sha}`
  let response = await request(archiveURL, options)
  if (response.status === 302) {
    const location = response.headers.get("location")
    if (!location) throw new Error("Missing GitHub archive redirect")
    const target = new URL(location, archiveURL)
    if (target.protocol !== "https:" || target.hostname !== "codeload.github.com" || target.port)
      throw new Error("Untrusted GitHub archive redirect")
    // Codeload may use a one-time signed URL. Never forward the OAuth header to the redirect.
    response = await request(target.toString(), { redirect: "manual", signal: AbortSignal.timeout(30_000) })
  }
  if (!response.ok || !response.body) throw new Error("Could not download selected repository")
  if (Number(response.headers.get("content-length")) > maxArchive) {
    await response.body.cancel()
    throw new Error("Repository archive exceeds 12 MiB")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxArchive) throw new Error("Repository archive exceeds 12 MiB")
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel()
    throw error
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error("Invalid GitHub archive")
  return { repo: fullName, branch, sha, archive: bytes.buffer }
}
