import { expect, test } from "vitest"
import { Octokit } from "@octokit/rest"
import { listInstalledRepositories } from "./github-repositories.js"

const firstPage = Array.from({ length: 100 }, (_, i) => ({ full_name: `leostera/repo-${i}`, private: true }))
test("Octokit includes repositories after the first 100 selected for an installation", async () => {
  const calls: string[] = []
  const client = new Octokit({
    auth: "test-token",
    request: {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push(url)
        expect(new Headers(init?.headers).get("authorization")).toBeTruthy()
        if (url.endsWith("/user/installations?per_page=100"))
          return Response.json({ total_count: 1, installations: [{ id: 7 }] })
        if (new URL(url).searchParams.get("page") === "1")
          return Response.json({ total_count: 101, repositories: firstPage })
        if (new URL(url).searchParams.get("page") === "2")
          return Response.json({ total_count: 101, repositories: [{ full_name: "leostera/r4", private: true }] })
        throw new Error("Unexpected URL")
      },
    },
  })
  const repositories = await listInstalledRepositories(client)
  expect(repositories).toHaveLength(101)
  expect(repositories.at(-1)).toEqual({ fullName: "leostera/r4", private: true })
  expect(calls).toHaveLength(3)
})

test("fails closed on incomplete installations and over-large selections", async () => {
  const incomplete = new Octokit({
    auth: "test-token",
    request: { fetch: async () => Response.json({ total_count: 2, installations: [{ id: 7 }] }) },
  })
  await expect(listInstalledRepositories(incomplete)).rejects.toThrow("incomplete")
  const tooMany = new Octokit({
    auth: "test-token",
    request: {
      fetch: async (url: string) =>
        Response.json(
          url.includes("/repositories")
            ? { total_count: 2001, repositories: firstPage }
            : { total_count: 1, installations: [{ id: 7 }] },
        ),
    },
  })
  await expect(listInstalledRepositories(tooMany)).rejects.toThrow("incomplete")
})
