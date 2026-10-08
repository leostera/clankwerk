import { createOpenAI } from "@ai-sdk/openai"
import type { CodexConnection } from "./codex.js"

/**
 * Responses API model for the user-authorized ChatGPT-plan token.
 * Never returns the credential to the browser or the code workspace. Only streamed,
 * non-stored inference through api.openai.com is permitted on this connection.
 */
export function createCodexModel(modelId: string, accessToken: () => Promise<string>) {
  return createOpenAI({
    apiKey: "oauth-resolved-server-side",
    fetch: (async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url)
      if (url.origin !== "https://api.openai.com" || url.pathname !== "/v1/responses")
        throw new Error("Unexpected Codex endpoint")
      if (typeof init?.body !== "string") throw new Error("Unexpected Codex request")
      const payload = JSON.parse(init.body) as Record<string, unknown>
      if (payload.stream !== true) throw new Error("Codex connection requires streamed inference")
      payload.store = false
      const token = await accessToken()
      const headers = new Headers(init.headers)
      headers.set("authorization", `Bearer ${token}`)
      return fetch(url, { ...init, headers, body: JSON.stringify(payload) })
    }) as typeof fetch,
  }).responses(modelId)
}

/** Resolve the saved model per turn. A configured model never silently falls back to another provider. */
export async function codexModelForAgent(
  connection: Pick<CodexConnection, "modelForAgent" | "accessToken">,
  agentId: string,
  required = false,
) {
  const modelId = await connection.modelForAgent(agentId)
  if (!modelId) {
    if (required) throw new Error("Choose an available default or agent model in Settings before starting a turn")
    return undefined
  }
  return createCodexModel(modelId, () => connection.accessToken())
}
