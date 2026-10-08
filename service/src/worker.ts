import { DurableObject } from "cloudflare:workers"
import { handleGitHubWebhook, type InstallationEvent } from "./github-webhook.ts"
import {
  base64url,
  callback,
  decodeBase64,
  exchangeGitHubCode,
  pkceChallenge,
  registeredReturnTo,
  refreshGitHubToken,
} from "./github-oauth.ts"
import { verifyInstanceRequest } from "@leostera/clankwerk/connectors/github-authorization"

const ttl = 10 * 60_000
const noStore = { "cache-control": "no-store" }
type Credential = Awaited<ReturnType<typeof exchangeGitHubCode>>
type Registry = Record<string, { returnTo: string; secret: string }>

function registry(env: Env): Registry {
  const entries = JSON.parse(env.INSTANCE_REGISTRY) as unknown
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid instance registry")
  const result = entries as Registry
  for (const [id, record] of Object.entries(result)) {
    if (
      !/^[a-z0-9-]{1,80}$/.test(id) ||
      !record ||
      typeof record.returnTo !== "string" ||
      typeof record.secret !== "string" ||
      record.secret.length < 32
    )
      throw new Error("Invalid instance registry")
    registeredReturnTo(record.returnTo, record.returnTo)
  }
  return result
}

async function limited(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > 2048) return null
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 2048) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export class GitHubOAuthSession extends DurableObject<Env> {
  private async key(): Promise<CryptoKey> {
    const bytes = decodeBase64(this.env.HANDOFF_ENCRYPTION_KEY)
    if (bytes.length !== 32) throw new Error("Invalid handoff encryption key")
    return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"])
  }
  async begin(instance: string, returnTo: string, verifier: string): Promise<void> {
    await this.ctx.storage.put("session", { instance, returnTo, verifier, at: Date.now(), status: "pending" })
    await this.ctx.storage.setAlarm(Date.now() + ttl)
  }
  async takeVerifier(): Promise<{ instance: string; returnTo: string; verifier: string } | null> {
    return this.ctx.storage.transaction(async (tx) => {
      const data = await tx.get<{ instance: string; returnTo: string; verifier: string; at: number; status: string }>(
        "session",
      )
      if (!data || data.status !== "pending" || Date.now() - data.at > ttl) return null
      await tx.put("session", { ...data, status: "redeeming" })
      return { instance: data.instance, returnTo: data.returnTo, verifier: data.verifier }
    })
  }
  async finish(credential: Credential): Promise<string> {
    const ticket = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await this.key(),
        new TextEncoder().encode(JSON.stringify(credential)),
      ),
    )
    await this.ctx.storage.transaction(async (tx) => {
      const data = await tx.get<{ status: string; at: number }>("session")
      if (!data || data.status !== "redeeming" || Date.now() - data.at > ttl) throw new Error("Authorization expired")
      await tx.put("session", { ...data, status: "ready", verifier: null })
      await tx.put("handoff", { ticket, iv: base64url(iv), data: base64url(encrypted) })
    })
    return ticket
  }
  async claim(instance: string, ticket: string): Promise<Credential | null> {
    const sealed = await this.ctx.storage.transaction(async (tx) => {
      const data = await tx.get<{ instance: string; at: number; status: string }>("session")
      const handoff = await tx.get<{ ticket: string; iv: string; data: string }>("handoff")
      if (
        !data ||
        data.instance !== instance ||
        data.status !== "ready" ||
        Date.now() - data.at > ttl ||
        !handoff ||
        handoff.ticket !== ticket
      )
        return null
      await tx.delete("handoff")
      await tx.put("session", { ...data, status: "claimed" })
      return handoff
    })
    if (!sealed) return null
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(sealed.iv) as BufferSource },
      await this.key(),
      decodeBase64(sealed.data) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as Credential
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}

/** Signed GitHub webhook metadata is not itself an authorization grant. */
export class GitHubInstallation extends DurableObject<Env> {
  async record(event: InstallationEvent): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      if ((await tx.get<string>("delivery")) === event.delivery) return
      await tx.put("delivery", event.delivery)
      await tx.put("installation", {
        id: event.installationId,
        accountId: event.accountId,
        accountLogin: event.accountLogin,
        repositorySelection: event.repositorySelection,
        action: event.action,
        receivedAt: Date.now(),
      })
    })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (!["clankwerk.leostera.dev", "127.0.0.1", "localhost"].includes(url.hostname))
      return new Response("Not found", { status: 404 })
    if (url.pathname === "/hooks/github")
      return handleGitHubWebhook(request, env.GITHUB_WEBHOOK_SECRET, (event) =>
        (env.INSTALLATIONS.getByName(`github:${event.installationId}`) as DurableObjectStub<GitHubInstallation>).record(
          event,
        ),
      )
    if (["/internal/start", "/internal/claim", "/internal/refresh"].includes(url.pathname)) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
      const body = await limited(request)
      if (!body) return new Response("Too large", { status: 413 })
      let payload: { instance?: string; returnTo?: string; state?: string; ticket?: string; refreshToken?: string }
      try {
        payload = JSON.parse(new TextDecoder().decode(body))
      } catch {
        return new Response("Invalid JSON", { status: 400 })
      }
      const entry = payload?.instance && registry(env)[payload.instance]
      if (!entry || !(await verifyInstanceRequest(request, entry.secret, body)))
        return new Response("Forbidden", { status: 403 })
      if (url.pathname === "/internal/start") {
        if (typeof payload.returnTo !== "string") return new Response("Missing return URL", { status: 400 })
        try {
          registeredReturnTo(payload.returnTo, entry.returnTo)
        } catch {
          return new Response("Unregistered return URL", { status: 400 })
        }
        const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
        const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
        await (env.OAUTH.getByName(state) as DurableObjectStub<GitHubOAuthSession>).begin(
          payload.instance!,
          entry.returnTo,
          verifier,
        )
        const authorize = new URL("https://github.com/login/oauth/authorize")
        authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
        authorize.searchParams.set("redirect_uri", callback)
        authorize.searchParams.set("state", state)
        authorize.searchParams.set("code_challenge", await pkceChallenge(verifier))
        authorize.searchParams.set("code_challenge_method", "S256")
        return Response.json({ authorize: authorize.toString(), state }, { headers: noStore })
      }
      if (url.pathname === "/internal/refresh") {
        if (typeof payload.refreshToken !== "string" || payload.refreshToken.length > 512)
          return new Response("Invalid refresh request", { status: 400 })
        try {
          return Response.json(
            await refreshGitHubToken(payload.refreshToken, env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
            { headers: noStore },
          )
        } catch {
          return new Response("Could not refresh GitHub connection; reconnect", { status: 502, headers: noStore })
        }
      }
      if (
        !payload.state ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.state) ||
        !payload.ticket ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.ticket)
      )
        return new Response("Invalid ticket", { status: 400 })
      const credential = await (env.OAUTH.getByName(payload.state) as DurableObjectStub<GitHubOAuthSession>).claim(
        payload.instance!,
        payload.ticket,
      )
      return credential
        ? Response.json(credential, { headers: noStore })
        : new Response("Expired ticket", { status: 410 })
    }
    if (url.pathname === "/auth/github/redirect") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
      const state = url.searchParams.get("state")
      const code = url.searchParams.get("code")
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 512)
        return new Response("No active GitHub authorization session", { status: 409, headers: noStore })
      const session = env.OAUTH.getByName(state) as DurableObjectStub<GitHubOAuthSession>
      const pending = await session.takeVerifier()
      if (!pending) return new Response("Authorization expired or already used", { status: 409, headers: noStore })
      try {
        const credential = await exchangeGitHubCode(
          code,
          pending.verifier,
          env.GITHUB_CLIENT_ID,
          env.GITHUB_CLIENT_SECRET,
        )
        const ticket = await session.finish(credential)
        const destination = new URL(pending.returnTo)
        destination.searchParams.set("state", state)
        destination.searchParams.set("ticket", ticket)
        return new Response(null, {
          status: 303,
          headers: { location: destination.toString(), ...noStore, "referrer-policy": "no-referrer" },
        })
      } catch {
        return new Response("Could not complete GitHub authorization; start again", { status: 502, headers: noStore })
      }
    }
    if (url.pathname === "/" && request.method === "GET")
      return Response.json(
        {
          service: "clankwerk-connect",
          github: {
            appId: env.GITHUB_APP_ID,
            clientId: env.GITHUB_CLIENT_ID,
            callback,
            webhook: "https://clankwerk.leostera.dev/hooks/github",
            webhookConfigured: Boolean(env.GITHUB_WEBHOOK_SECRET),
            oauthReady: true,
          },
        },
        { headers: noStore },
      )
    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
