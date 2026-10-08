const MAX_BODY = 1_048_576
const encoder = new TextEncoder()

export type InstallationEvent = {
  delivery: string
  action: string
  installationId: number
  accountId: number
  accountLogin: string
  repositorySelection: "all" | "selected" | null
}

export async function verifyGitHubSignature(
  body: Uint8Array,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature ?? "")) return false
  const expected = new Uint8Array(32)
  for (let i = 0; i < expected.length; i++) expected[i] = parseInt(signature!.slice(7 + i * 2, 9 + i * 2), 16)
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ])
  return crypto.subtle.verify("HMAC", key, expected, body as BufferSource)
}

export async function handleGitHubWebhook(
  request: Request,
  secret: string | undefined,
  record: (event: InstallationEvent) => Promise<void>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  if (!secret) return new Response("Webhook is not configured", { status: 503 })
  if (Number(request.headers.get("content-length")) > MAX_BODY) return new Response("Too large", { status: 413 })
  const reader = request.body?.getReader()
  if (!reader) return new Response("Missing body", { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      return new Response("Too large", { status: 413 })
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (!(await verifyGitHubSignature(body, request.headers.get("x-hub-signature-256"), secret)))
    return new Response("Invalid signature", { status: 401 })
  const delivery = request.headers.get("x-github-delivery")
  if (!delivery || !/^[0-9a-f-]{36}$/i.test(delivery)) return new Response("Invalid delivery ID", { status: 400 })
  const event = request.headers.get("x-github-event")
  if (event !== "installation" && event !== "installation_repositories")
    return Response.json({ accepted: true, handled: false }, { status: 202 })
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }
  if (!payload || typeof payload !== "object") return new Response("Invalid event", { status: 400 })
  const data = payload as Record<string, unknown>
  const installation = data.installation as Record<string, unknown> | undefined
  const account = installation?.account as Record<string, unknown> | undefined
  if (
    !installation ||
    !Number.isSafeInteger(installation.id) ||
    !(Number(installation.id) > 0) ||
    !account ||
    !Number.isSafeInteger(account.id) ||
    typeof account.login !== "string" ||
    !/^[a-zA-Z0-9-]{1,39}$/.test(account.login) ||
    typeof data.action !== "string"
  )
    return new Response("Invalid installation", { status: 400 })
  try {
    await record({
      delivery,
      action: data.action,
      installationId: installation.id as number,
      accountId: account.id as number,
      accountLogin: account.login,
      repositorySelection:
        installation.repository_selection === "all" || installation.repository_selection === "selected"
          ? installation.repository_selection
          : null,
    })
  } catch {
    // GitHub retries non-2xx deliveries. Do not claim acceptance if persistence failed.
    return new Response("Could not record delivery", { status: 503 })
  }
  return Response.json({ accepted: true }, { status: 202 })
}
