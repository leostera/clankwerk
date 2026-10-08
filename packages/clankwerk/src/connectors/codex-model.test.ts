import { describe, expect, it, vi } from "vitest"
import { codexModelForAgent } from "./codex-model.js"
import type { CodexConnection } from "./codex.js"

const stub = (choice?: string) =>
  ({
    modelForAgent: vi.fn(async () => choice),
    accessToken: vi.fn(async () => "token-must-stay-server-side"),
  }) as unknown as Pick<CodexConnection, "modelForAgent" | "accessToken">

describe("per-turn Codex selection", () => {
  it("does not fetch credentials when no model is configured", async () => {
    const connection = stub()
    expect(await codexModelForAgent(connection, "researcher")).toBeUndefined()
    expect(connection.accessToken).not.toHaveBeenCalled()
    await expect(codexModelForAgent(connection, "coder", true)).rejects.toThrow("Choose an available")
    expect(connection.accessToken).not.toHaveBeenCalled()
  })
  it("uses the selected model without revealing the access token", async () => {
    const connection = stub("gpt-5.4")
    const model = await codexModelForAgent(connection, "coder", true)
    expect(model?.modelId).toBe("gpt-5.4")
    expect(connection.modelForAgent).toHaveBeenCalledWith("coder")
    expect(connection.accessToken).not.toHaveBeenCalled()
  })
})
