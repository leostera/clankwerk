import { expect, test, vi } from "vitest"
import type { GitHubConnectionEnv } from "./github-connection.js"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { GitHubConnection } = await import("./github-connection.js")

function fixture() {
  const values = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  }
  let refreshes = 0
  const env: GitHubConnectionEnv = {
    GITHUB_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    CLANKWERK_INSTANCE_SECRET: "test-instance-secret-".repeat(3),
    GITHUB_INSTANCE_NAME: "test-instance",
    GITHUB_CONNECT_ORIGIN: "https://connect.example.test/",
    GITHUB_OWNER: "leostera",
    GITHUB_REPO: "r4",
    GITHUB_BASE: "main",
    GITHUB_BRANCH_PREFIX: "r4",
    CLANKWERK_CONNECT: {
      fetch: async (input: string, init: RequestInit) => {
        refreshes++
        expect(new URL(input).pathname).toBe("/internal/refresh")
        expect(init.headers).toHaveProperty("x-clankwerk-signature")
        expect(JSON.parse(String(init.body))).toMatchObject({ instance: "test-instance" })
        return Response.json({
          accessToken: "ghu_rotated",
          refreshToken: "ghr_rotated",
          expiresAt: Date.now() + 60 * 60_000,
          refreshExpiresAt: Date.now() + 24 * 60 * 60_000,
        })
      },
    } as GitHubConnectionEnv["CLANKWERK_CONNECT"],
  }
  const connection = new GitHubConnection(
    { storage } as unknown as ConstructorParameters<typeof GitHubConnection>[0],
    env,
  )
  return { connection, values, refreshes: () => refreshes }
}

test("GitHub user tokens remain sealed in storage and rotate only through the signed service binding", async () => {
  const { connection, values, refreshes } = fixture()
  await connection.save({
    accessToken: "ghu_initial",
    refreshToken: "ghr_initial",
    expiresAt: Date.now() - 1,
    accountId: 123,
    login: "leostera",
  })
  expect(JSON.stringify(values.get("connection"))).not.toContain("ghu_initial")
  expect(await connection.status()).toMatchObject({ connected: true, login: "leostera", expired: false })
  expect(refreshes()).toBe(1)
  expect(JSON.stringify(values.get("connection"))).not.toContain("ghu_rotated")
  await connection.disconnect()
  expect(await connection.status()).toEqual({ connected: false })
})
