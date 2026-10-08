export function gitReadRoute(repo: string, request: Request): "refs" | "upload-pack" | null {
  if (!/^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/.test(repo)) return null
  const url = new URL(request.url)
  if (url.protocol !== "https:" || url.host !== "github.com") return null
  if (
    url.pathname === `/${repo}.git/info/refs` &&
    request.method === "GET" &&
    url.search === "?service=git-upload-pack"
  )
    return "refs"
  if (url.pathname === `/${repo}.git/git-upload-pack` && request.method === "POST" && !url.search) return "upload-pack"
  return null
}

/** Run only in the trusted instance Worker, never in Coder's container. */
export async function proxyGitRead(
  repo: string,
  token: string,
  request: Request,
  send: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const route = gitReadRoute(repo, request)
  if (!route) return new Response("Git read operation not allowed", { status: 403 })
  let body: Uint8Array | undefined
  if (route === "upload-pack") {
    const reader = request.body?.getReader()
    if (!reader) return new Response("Missing Git request", { status: 400 })
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 65_536) {
        await reader.cancel()
        return new Response("Git request too large", { status: 413 })
      }
      chunks.push(value)
    }
    body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    // Git protocol v0/v1 only; no receive-pack or arbitrary POST forwarding.
    const payload = new TextDecoder().decode(body)
    if (
      !payload.includes("want ") ||
      !payload.includes("done") ||
      payload.includes("git-receive-pack") ||
      payload.includes("push-cert")
    )
      return new Response("Unsupported Git read request", { status: 400 })
  }
  const headers = new Headers({
    authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
    "user-agent": "clankwerk-git-read",
    accept: route === "refs" ? "*/*" : "application/x-git-upload-pack-result",
  })
  if (route === "upload-pack") headers.set("content-type", "application/x-git-upload-pack-request")
  const upstream = await send(request.url, {
    method: request.method,
    headers,
    body: body ? new Uint8Array(body).buffer : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  })
  if (upstream.status >= 300 && upstream.status < 400) return new Response("Git redirect denied", { status: 502 })
  const forwarded = new Headers({ "cache-control": "no-store" })
  const contentType = upstream.headers.get("content-type")
  if (contentType?.startsWith("application/x-git-")) forwarded.set("content-type", contentType)
  return new Response(upstream.body, { status: upstream.status, headers: forwarded })
}
