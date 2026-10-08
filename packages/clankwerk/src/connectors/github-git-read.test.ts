import { expect, test } from "vitest"
import { gitReadRoute, proxyGitRead } from "./github-git-read.js"

const repo = "leostera/r4"
const base = "https://github.com/leostera/r4.git"
test("allowlists only the selected repository's git-upload-pack, never push", () => {
  expect(gitReadRoute(repo, new Request(`${base}/info/refs?service=git-upload-pack`))).toBe("refs")
  expect(gitReadRoute(repo, new Request(`${base}/git-upload-pack`, { method: "POST" }))).toBe("upload-pack")
  for (const url of [
    `${base}/info/refs?service=git-receive-pack`,
    `${base}/git-receive-pack`,
    "https://attacker.example/leostera/r4.git/info/refs?service=git-upload-pack",
    "https://github.com/leostera/other.git/info/refs?service=git-upload-pack",
    `${base}/info/refs?service=git-upload-pack&other=true`,
  ])
    expect(gitReadRoute(repo, new Request(url))).toBeNull()
})

test("injects auth upstream only and strips all upstream headers except Git content-type", async () => {
  const send = async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(`${base}/info/refs?service=git-upload-pack`)
    expect(new Headers(init?.headers).get("authorization")?.startsWith("Basic ")).toBe(true)
    return new Response("git-advertisement", {
      headers: {
        "content-type": "application/x-git-upload-pack-advertisement",
        "set-cookie": "private",
        "x-github-request-id": "internal",
      },
    })
  }
  const output = await proxyGitRead(repo, "fake-token", new Request(`${base}/info/refs?service=git-upload-pack`), send)
  expect(output.status).toBe(200)
  expect(output.headers.get("set-cookie")).toBeNull()
  expect(output.headers.get("x-github-request-id")).toBeNull()
})

test("denies push and redirects before returning a response to the sandbox", async () => {
  const fail = async () => {
    throw new Error("Must not fetch an unapproved Git URL")
  }
  const push = await proxyGitRead(repo, "fake-token", new Request(`${base}/git-receive-pack`, { method: "POST" }), fail)
  expect(push.status).toBe(403)
  const redirect = await proxyGitRead(
    repo,
    "fake-token",
    new Request(`${base}/info/refs?service=git-upload-pack`),
    async () => new Response(null, { status: 302, headers: { location: "https://attacker.example" } }),
  )
  expect(redirect.status).toBe(502)
})
