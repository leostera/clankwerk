import { describe, expect, it, vi } from "vitest"
import { handleCodexSettingsRequest } from "./codex-settings.js"

type Connection = Parameters<typeof handleCodexSettingsRequest>[1]
function stub() {
  return {
    statusWithHost: vi.fn(async () => ({ connected: false, hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" })),
    disconnect: vi.fn(async () => {}),
    importConnection: vi.fn(async (_input: unknown) => ({ connected: true as const, lunaAvailable: false })),
  }
}

const endpoint = "https://admin.example.com/api/settings/codex"

describe("Codex Settings handler (called after the admin host gate)", () => {
  it("exposes only connection status, never credentials", async () => {
    const connection = stub()
    const response = await handleCodexSettingsRequest(new Request(endpoint), connection as Connection)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ connected: false, hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" })
  })
  it("rejects cross-origin mutations", async () => {
    const connection = stub()
    for (const method of ["POST", "DELETE"]) {
      const response = await handleCodexSettingsRequest(
        new Request(endpoint, {
          method,
          headers: { origin: "https://attacker.example", "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
        connection as Connection,
      )
      expect(response.status).toBe(403)
    }
    expect(connection.importConnection).not.toHaveBeenCalled()
    expect(connection.disconnect).not.toHaveBeenCalled()
  })
  it("bounds the body and never echoes malformed credentials", async () => {
    const connection = stub()
    const invalid = await handleCodexSettingsRequest(
      new Request(endpoint, {
        method: "POST",
        headers: { origin: "https://admin.example.com", "content-type": "application/json" },
        body: '{"secret":"Bearer sensitive-data",',
      }),
      connection as Connection,
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).not.toContain("sensitive-data")
    const oversized = await handleCodexSettingsRequest(
      new Request(endpoint, {
        method: "POST",
        headers: { origin: "https://admin.example.com", "content-type": "application/json" },
        body: JSON.stringify({ secret: "x".repeat(40_000) }),
      }),
      connection as Connection,
    )
    expect(oversized.status).toBe(413)
    expect(connection.importConnection).not.toHaveBeenCalled()
  })
  it("accepts a same-origin import and disconnect", async () => {
    const connection = stub()
    const imported = await handleCodexSettingsRequest(
      new Request(endpoint, {
        method: "POST",
        headers: { origin: "https://admin.example.com", "content-type": "application/json" },
        body: "{}",
      }),
      connection as Connection,
    )
    expect(imported.status).toBe(201)
    expect(connection.importConnection).toHaveBeenCalledOnce()
    const deleted = await handleCodexSettingsRequest(
      new Request(endpoint, {
        method: "DELETE",
        headers: { origin: "https://admin.example.com" },
      }),
      connection as Connection,
    )
    expect(deleted.status).toBe(204)
    expect(connection.disconnect).toHaveBeenCalledOnce()
  })
})
