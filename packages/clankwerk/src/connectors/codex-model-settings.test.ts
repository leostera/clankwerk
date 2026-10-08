import { describe, expect, it, vi } from "vitest"
import { handleCodexModelSettingsRequest } from "./codex-model-settings.js"
import type { CodexConnection } from "./codex.js"

const origin = "https://admin.example"
const models = [{ slug: "gpt-5.4", displayName: "GPT-5.4" }]
function stub(connected = true) {
  let defaultModel: string | undefined
  let override: string | undefined
  const connection = {
    status: vi.fn(async () => ({ connected })),
    listModels: vi.fn(async () => models),
    defaultModel: vi.fn(async () => defaultModel),
    agentOverride: vi.fn(async () => override),
    setDefaultModel: vi.fn(async (slug: string) => {
      if (!models.some((item) => item.slug === slug)) throw new Error("unavailable")
      defaultModel = slug
    }),
    clearDefaultModel: vi.fn(async () => {
      defaultModel = undefined
    }),
    setAgentOverride: vi.fn(async (_agent: string, slug: string) => {
      if (!models.some((item) => item.slug === slug)) throw new Error("unavailable")
      override = slug
    }),
    clearAgentOverride: vi.fn(async () => {
      override = undefined
    }),
  }
  return connection as typeof connection & CodexConnection
}
const req = (method: string, body?: unknown, from = origin) =>
  new Request(`${origin}/api/settings/codex/models`, {
    method,
    headers: { origin: from, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

describe("model settings", () => {
  it("returns only available models, default and per-agent choice", async () => {
    const connection = stub()
    const response = await handleCodexModelSettingsRequest(req("GET"), connection, "coder")
    expect(await response.json()).toEqual({ models, defaultModel: null, override: null })
    expect(response.headers.get("content-type")).toContain("application/json")
  })
  it("persists the default and agent override separately", async () => {
    const connection = stub()
    expect((await handleCodexModelSettingsRequest(req("PUT", { model: "gpt-5.4" }), connection)).status).toBe(200)
    expect((await handleCodexModelSettingsRequest(req("PUT", { model: "gpt-5.4" }), connection, "coder")).status).toBe(
      200,
    )
    expect(await (await handleCodexModelSettingsRequest(req("GET"), connection, "coder")).json()).toEqual({
      models,
      defaultModel: "gpt-5.4",
      override: "gpt-5.4",
    })
    expect((await handleCodexModelSettingsRequest(req("DELETE"), connection, "coder")).status).toBe(204)
    expect(await connection.defaultModel()).toBe("gpt-5.4")
    expect(await connection.agentOverride("coder")).toBeUndefined()
  })
  it("rejects cross-origin mutation, disconnected accounts, oversized and unavailable choices", async () => {
    const connection = stub()
    expect(
      (await handleCodexModelSettingsRequest(req("PUT", { model: "gpt-5.4" }, "https://evil.example"), connection))
        .status,
    ).toBe(403)
    expect(connection.setDefaultModel).not.toHaveBeenCalled()
    expect((await handleCodexModelSettingsRequest(req("PUT", { model: "gpt-6-luna" }), connection)).status).toBe(400)
    expect((await handleCodexModelSettingsRequest(req("PUT", { model: "x".repeat(600) }), connection)).status).toBe(413)
    expect((await handleCodexModelSettingsRequest(req("GET"), stub(false))).status).toBe(409)
    expect((await handleCodexModelSettingsRequest(req("POST"), connection)).status).toBe(405)
  })
})
