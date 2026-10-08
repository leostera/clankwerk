import type { CodexConnection } from "./codex.js"

type ModelConnection = Pick<
  CodexConnection,
  | "status"
  | "listModels"
  | "defaultModel"
  | "agentOverride"
  | "setDefaultModel"
  | "clearDefaultModel"
  | "setAgentOverride"
  | "clearAgentOverride"
>

/** Route only from an Access-protected admin host. An agentId must be allowlisted by the instance. */
export async function handleCodexModelSettingsRequest(
  request: Request,
  connection: ModelConnection,
  agentId?: string,
): Promise<Response> {
  if (!(["GET", "PUT", "DELETE"] as string[]).includes(request.method))
    return new Response("Method not allowed", { status: 405 })
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin)
    return new Response("Forbidden", { status: 403 })
  if (!(await connection.status()).connected)
    return Response.json({ error: "Connect ChatGPT in Settings first" }, { status: 409 })
  if (request.method === "GET") {
    try {
      return Response.json({
        models: await connection.listModels(),
        defaultModel: (await connection.defaultModel()) ?? null,
        ...(agentId ? { override: (await connection.agentOverride(agentId)) ?? null } : {}),
      })
    } catch {
      return Response.json({ error: "Could not load available ChatGPT models" }, { status: 502 })
    }
  }
  if (request.method === "DELETE") {
    if (agentId) await connection.clearAgentOverride(agentId)
    else await connection.clearDefaultModel()
    return new Response(null, { status: 204 })
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response("Expected JSON", { status: 415 })
  // A model identifier is small. Bound both declared and streamed payloads.
  if (Number(request.headers.get("content-length")) > 512) return new Response("Too large", { status: 413 })
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 512) {
        await reader.cancel()
        return new Response("Too large", { status: 413 })
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let model: unknown
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown }
    model = payload?.model
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }
  if (typeof model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(model))
    return Response.json({ error: "Select an available model" }, { status: 400 })
  try {
    if (agentId) await connection.setAgentOverride(agentId, model)
    else await connection.setDefaultModel(model)
    return Response.json({ model })
  } catch {
    return Response.json({ error: "Model is not available for this account" }, { status: 400 })
  }
}
