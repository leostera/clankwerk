import { expect, test } from "vitest"
import { Octokit } from "@octokit/rest"
import { fetchSelectedSnapshot as fetchScoped } from "./github-archive.js"

const fetchSelectedSnapshot = (
  repo: string,
  client: Octokit,
  token: string,
  request?: Parameters<typeof fetchScoped>[4],
) => fetchScoped("leostera", repo, client, token, request)

const sha = "a".repeat(40)
const headers = new Headers({ location: `https://codeload.github.com/leostera/r4/legacy.tar.gz/${sha}` })
const client = new Octokit({
  auth: "fake-token",
  request: {
    fetch: async (url: string) => {
      if (url.includes("/user/installations?")) return Response.json({ total_count: 1, installations: [{ id: 99 }] })
      if (url.includes("/user/installations/99/repositories?"))
        return Response.json({ total_count: 1, repositories: [{ full_name: "leostera/r4", private: true }] })
      if (url.endsWith("/repos/leostera/r4")) return Response.json({ full_name: "leostera/r4", default_branch: "main" })
      if (
        url.endsWith("/commits/main") ||
        url.endsWith(`/commits/${sha}`) ||
        url.endsWith(`/commits/${"f".repeat(40)}`)
      )
        return Response.json({ sha })
      throw new Error("Unexpected GitHub REST request")
    },
  },
})
const request = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith(`/tarball/${sha}`)) return new Response(null, { status: 302, headers })
  if (url.startsWith("https://codeload.github.com/")) {
    expect(init?.headers).toBeUndefined() // Never leak the OAuth credential across the redirect.
    return new Response(new Uint8Array([0x1f, 0x8b, 0x08]))
  }
  throw new Error("Unexpected GitHub request")
}

test("only transfers a selected private repo snapshot and strips the OAuth token at codeload", async () => {
  const result = await fetchSelectedSnapshot("r4", client, "fake-token", request)
  expect(result.repo).toBe("leostera/r4")
  expect(result.sha).toBe(sha)
  expect(new Uint8Array(result.archive)).toEqual(new Uint8Array([0x1f, 0x8b, 0x08]))
})

test("rejects unselected repos and redirects to untrusted hosts", async () => {
  await expect(fetchSelectedSnapshot("secret", client, "fake-token", request)).rejects.toThrow("not selected")
  const redirect = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await request(input, init)
    return String(input).endsWith(`/tarball/${sha}`)
      ? new Response(null, { status: 302, headers: { location: "https://attacker.example/secret" } })
      : response
  }
  await expect(fetchSelectedSnapshot("r4", client, "fake-token", redirect)).rejects.toThrow("Untrusted")
})

test("accepts a token verified for exactly this repository and rejects another scope", async () => {
  const result = await fetchScoped("leostera", "r4", client, "ghs_fake", request, "leostera/r4")
  expect(result.repo).toBe("leostera/r4")
  await expect(fetchScoped("leostera", "r4", client, "ghs_fake", request, "leostera/other")).rejects.toThrow(
    "not selected",
  )
})

test("a review archive is pinned to its exact PR head rather than current main", async () => {
  const result = await fetchScoped("leostera", "r4", client, "ghs_fake", request, "leostera/r4", sha)
  expect(result.sha).toBe(sha)
  await expect(
    fetchScoped("leostera", "r4", client, "ghs_fake", request, "leostera/r4", "f".repeat(40)),
  ).rejects.toThrow("Invalid or moved repository commit")
})

test("rejects an oversized archive before the Sandbox sees it", async () => {
  const oversized = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await request(input, init)
    return String(input).startsWith("https://codeload.github.com/")
      ? new Response(new Uint8Array([0x1f, 0x8b]), { headers: { "content-length": String(13 * 1024 * 1024) } })
      : response
  }
  await expect(fetchSelectedSnapshot("r4", client, "fake-token", oversized)).rejects.toThrow("12 MiB")
})
