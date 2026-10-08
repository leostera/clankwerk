import type { CodexConnection } from "./codex.js"

const MAX_BODY = 32_768
const allowedErrors = new Set([
  "Invalid connection",
  "Invalid client registration",
  "Invalid host ID",
  "Connection was authorized for a different host",
  "ChatGPT plan usage permission is required",
  "Disconnect the existing account before connecting another",
  "OpenAI did not accept this connection",
  "Could not verify the ChatGPT model catalog",
  "Invalid token expiry",
])

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) return null
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

type ConnectionStub = Pick<CodexConnection, "statusWithHost" | "disconnect" | "importConnection">

/** Call only *after* the instance has gated requests to its Access-protected admin host. */
export async function handleCodexSettingsRequest(request: Request, connection: ConnectionStub): Promise<Response> {
  if (request.method === "GET") return Response.json(await connection.statusWithHost())
  if (request.method !== "POST" && request.method !== "DELETE")
    return new Response("Method not allowed", { status: 405 })
  // Access authenticates the admin host; strict Origin prevents cross-site browser mutations.
  if (request.headers.get("origin") !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 })
  if (request.method === "DELETE") {
    await connection.disconnect()
    return new Response(null, { status: 204 })
  }
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response("Expected JSON", { status: 415 })
  const bytes = await readLimitedBody(request)
  if (!bytes) return new Response("Too large", { status: 413 })
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }
  try {
    return Response.json(await connection.importConnection(payload), { status: 201 })
  } catch (error) {
    // Never echo a token, JSON parsing snippet, or upstream response body.
    const message = error instanceof Error ? error.message : "Could not connect"
    return Response.json(
      {
        error:
          allowedErrors.has(message) ||
          /^Invalid (clientId|accessToken|refreshToken|idToken|scope|hostId)$/.test(message)
            ? message
            : "Could not verify this ChatGPT connection",
      },
      { status: 400 },
    )
  }
}
