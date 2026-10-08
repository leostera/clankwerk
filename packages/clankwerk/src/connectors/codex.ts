import { DurableObject } from "cloudflare:workers"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { listedCodexModels, type ListedModel } from "./codex-catalog.js"

const issuer = "https://auth.openai.com"
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
const requiredScopes = ["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"]

type Credential = {
  clientId: string
  subject: string
  email?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
  hostId: string
  idToken: string
}

type Sealed = { iv: string; data: string }

export interface CodexEnv {
  CODEX_ENCRYPTION_KEY?: string
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0))
}

export async function validateCodexIdentity(idToken: string, clientId: string) {
  const { payload } = await jwtVerify(idToken, jwks, { issuer, audience: clientId })
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Invalid ChatGPT subject")
  return { subject: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined }
}

export class CodexConnection extends DurableObject<CodexEnv> {
  private refreshPending?: Promise<Credential>

  private async key(): Promise<CryptoKey> {
    if (!this.env.CODEX_ENCRYPTION_KEY) throw new Error("Codex encryption key is not configured")
    const raw = decode(this.env.CODEX_ENCRYPTION_KEY)
    if (raw.byteLength !== 32) throw new Error("Invalid Codex encryption key")
    return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"])
  }

  private async read(): Promise<Credential | undefined> {
    const sealed = await this.ctx.storage.get<Sealed>("connection")
    if (!sealed) return undefined
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(sealed.iv) as BufferSource },
      await this.key(),
      decode(sealed.data) as BufferSource,
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as Credential
  }

  private async seal(connection: Credential): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.key(),
      new TextEncoder().encode(JSON.stringify(connection)),
    )
    return { iv: encode(iv), data: encode(new Uint8Array(encrypted)) }
  }

  private async save(connection: Credential): Promise<void> {
    await this.ctx.storage.put("connection", await this.seal(connection))
  }

  async statusWithHost(): Promise<{
    connected: boolean
    hostId: string
    email?: string
    expiresAt?: number
    defaultModel?: string
  }> {
    let hostId = await this.ctx.storage.get<string>("hostId")
    if (!hostId) {
      hostId = `urn:uuid:${crypto.randomUUID()}`
      await this.ctx.storage.put("hostId", hostId)
    }
    return { ...(await this.status()), hostId }
  }

  async status(): Promise<{ connected: boolean; email?: string; expiresAt?: number; defaultModel?: string }> {
    const connection = await this.read()
    return connection
      ? {
          connected: true,
          email: connection.email,
          expiresAt: connection.expiresAt,
          defaultModel: await this.defaultModel(),
        }
      : { connected: false }
  }

  async importConnection(input: unknown): Promise<{ connected: true; email?: string }> {
    if (!input || typeof input !== "object") throw new Error("Invalid connection")
    const record = input as Record<string, unknown>
    for (const field of ["clientId", "accessToken", "refreshToken", "idToken", "scope", "hostId"])
      if (typeof record[field] !== "string" || !record[field] || record[field].length > 10_000)
        throw new Error(`Invalid ${field}`)
    if (!/^oaiapp_[a-zA-Z0-9_-]+$/.test(record.clientId as string)) throw new Error("Invalid client registration")
    if (!/^(urn:uuid:[0-9a-f-]{36}|urn:ietf:params:oauth:jwk-thumbprint:.+)$/.test(record.hostId as string))
      throw new Error("Invalid host ID")
    const { hostId } = await this.statusWithHost()
    if (record.hostId !== hostId) throw new Error("Connection was authorized for a different host")
    const granted = (record.scope as string).split(/\s+/)
    if (!requiredScopes.every((scope) => granted.includes(scope)))
      throw new Error("ChatGPT plan usage permission is required")
    const { subject, email } = await validateCodexIdentity(record.idToken as string, record.clientId as string)
    const existing = await this.read()
    if (existing && existing.subject !== subject)
      throw new Error("Disconnect the existing account before connecting another")
    // Verify that this is an active access token for the documented API, not only a valid identity token.
    const check = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${record.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!check.ok) throw new Error("OpenAI did not accept this connection")
    const catalog = (await check.json()) as { models?: { slug?: string }[] }
    if (!Array.isArray(catalog.models)) throw new Error("Could not verify the ChatGPT model catalog")
    const expiresIn = Number(record.expiresIn)
    if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86_400) throw new Error("Invalid token expiry")
    await this.save({
      clientId: record.clientId as string,
      subject,
      email,
      accessToken: record.accessToken as string,
      refreshToken: record.refreshToken as string,
      expiresAt: Date.now() + expiresIn * 1000,
      scope: record.scope as string,
      hostId: record.hostId as string,
      idToken: record.idToken as string,
    })
    return { connected: true, email }
  }

  async disconnect(): Promise<void> {
    await this.ctx.storage.transaction(async (tx) => {
      for (const name of (await tx.list({ prefix: "model:" })).keys()) await tx.delete(name)
      await tx.delete("connection")
    })
  }

  /** Catalog from the connected ChatGPT account, not from the Workers AI model list. */
  async listModels(): Promise<ListedModel[]> {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error("Could not load available ChatGPT models")
    return listedCodexModels(await response.json())
  }

  async defaultModel(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("model:default")
  }

  async agentOverride(agentId: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`model:agent:${agentId}`)
  }

  async modelForAgent(agentId: string): Promise<string | undefined> {
    return (await this.agentOverride(agentId)) ?? (await this.defaultModel())
  }

  private async assertAvailable(slug: string): Promise<void> {
    if (!(await this.listModels()).some((model) => model.slug === slug))
      throw new Error("Select a model from the available ChatGPT models")
  }

  private async saveModel(key: string, slug: string): Promise<void> {
    const expected = await this.ctx.storage.get<Sealed>("connection")
    if (!expected) throw new Error("Connect ChatGPT in Settings first")
    await this.assertAvailable(slug)
    await this.ctx.storage.transaction(async (tx) => {
      const latest = await tx.get<Sealed>("connection")
      if (!latest || latest.iv !== expected.iv || latest.data !== expected.data)
        throw new Error("Connection changed while saving model; try again")
      await tx.put(key, slug)
    })
  }

  async setDefaultModel(slug: string): Promise<void> {
    await this.saveModel("model:default", slug)
  }

  async clearDefaultModel(): Promise<void> {
    await this.ctx.storage.delete("model:default")
  }

  async setAgentOverride(agentId: string, slug: string): Promise<void> {
    await this.saveModel(`model:agent:${agentId}`, slug)
  }

  async clearAgentOverride(agentId: string): Promise<void> {
    await this.ctx.storage.delete(`model:agent:${agentId}`)
  }

  async accessToken(): Promise<string> {
    const credential = await this.read()
    if (!credential) throw new Error("Connect ChatGPT in Settings before submitting a Coder turn")
    if (credential.expiresAt > Date.now() + 120_000) return credential.accessToken
    if (!this.refreshPending)
      this.refreshPending = this.refresh(credential).finally(() => {
        this.refreshPending = undefined
      })
    return (await this.refreshPending).accessToken
  }

  private async refresh(current: Credential): Promise<Credential> {
    // A rotating refresh token must be replaced atomically with the access token.
    const expected = await this.ctx.storage.get<Sealed>("connection")
    if (!expected) throw new Error("Connection was disconnected")
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: current.clientId,
        refresh_token: current.refreshToken,
        resource: "https://api.openai.com/v1",
      }),
    })
    if (!response.ok) throw new Error("ChatGPT connection expired; reconnect in Settings")
    const token = (await response.json()) as Record<string, unknown>
    if (
      typeof token.access_token !== "string" ||
      typeof token.refresh_token !== "string" ||
      typeof token.expires_in !== "number" ||
      token.expires_in < 60
    )
      throw new Error("Invalid ChatGPT refresh response")
    const scope = typeof token.scope === "string" ? token.scope : current.scope
    if (!requiredScopes.every((s) => scope.split(/\s+/).includes(s)))
      throw new Error("ChatGPT plan usage permission was removed")
    const updated = {
      ...current,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      scope,
    }
    // A disconnect or reconnect may happen while OpenAI rotates the token. Never resurrect stale credentials.
    const sealed = await this.seal(updated)
    await this.ctx.storage.transaction(async (tx) => {
      const latest = await tx.get<Sealed>("connection")
      if (!latest || latest.iv !== expected.iv || latest.data !== expected.data)
        throw new Error("Connection changed during refresh; reconnect in Settings")
      await tx.put("connection", sealed)
    })
    return updated
  }
}
