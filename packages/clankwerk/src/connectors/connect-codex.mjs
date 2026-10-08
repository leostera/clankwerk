#!/usr/bin/env node
// Run on the operator's laptop. OAuth credentials live in memory and are sent only to
// the Access-authenticated Settings page via a same-origin-targeted postMessage.
import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { createRemoteJWKSet, jwtVerify } from "jose"

const target = process.argv[2]
if (!target) throw new Error("Usage: clankwerk-codex-connect <https://your-admin-host>")
const admin = new URL(target)
if (
  admin.origin !== target ||
  admin.username ||
  admin.password ||
  !(admin.protocol === "https:" || (admin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(admin.hostname)))
)
  throw new Error("Expected an HTTPS admin origin or a local development origin")
const origin = admin.origin
const issuer = "https://auth.openai.com"
const resource = "https://api.openai.com/v1"
const callback = "http://127.0.0.1:1455/auth/callback"
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
let pending

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'")
  const url = new URL(req.url || "/", callback)
  if (req.method !== "GET") {
    res.writeHead(405).end()
    return
  }
  if (url.pathname === "/start") {
    const hostId = url.searchParams.get("host")
    if (!hostId || !/^urn:uuid:[0-9a-f-]{36}$/.test(hostId) || pending) {
      res.writeHead(400).end("Invalid host or sign-in already in progress")
      return
    }
    const state = randomBytes(24).toString("base64url")
    const nonce = randomBytes(24).toString("base64url")
    const verifier = randomBytes(48).toString("base64url")
    pending = { state, nonce, verifier, hostId, started: Date.now() }
    const authorize = new URL(`${issuer}/api/accounts/authorize`)
    authorize.search = new URLSearchParams({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Clankwerk",
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: callback,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString()
    res.writeHead(302, { Location: authorize.toString() }).end()
    return
  }
  if (url.pathname !== "/auth/callback" || !pending) {
    res.writeHead(404).end()
    return
  }
  const attempt = pending
  pending = undefined
  try {
    if (Date.now() - attempt.started > 10 * 60_000 || url.searchParams.get("state") !== attempt.state)
      throw new Error("Sign-in expired or state did not match")
    if (url.searchParams.get("error")) throw new Error("Sign-in was not authorized")
    const code = url.searchParams.get("code")
    const clientId = url.searchParams.get("client_id")
    if (!code || !clientId || !/^oaiapp_[a-zA-Z0-9_-]+$/.test(clientId)) throw new Error("Registration incomplete")
    const exchange = await fetch(`${issuer}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: callback,
        resource,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!exchange.ok) throw new Error(`Token exchange failed (${exchange.status})`)
    const token = await exchange.json()
    if (
      typeof token.id_token !== "string" ||
      typeof token.access_token !== "string" ||
      typeof token.refresh_token !== "string" ||
      !Number.isFinite(token.expires_in) ||
      typeof token.scope !== "string"
    )
      throw new Error("Incomplete token response")
    const { payload } = await jwtVerify(token.id_token, jwks, { issuer, audience: clientId })
    if (payload.nonce !== attempt.nonce || !payload.sub) throw new Error("Identity verification failed")
    if (!token.scope.split(/\s+/).includes("chatgpt.tokens.use.direct"))
      throw new Error("ChatGPT plan usage was not granted")
    const connection = {
      clientId,
      hostId: attempt.hostId,
      idToken: token.id_token,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      scope: token.scope,
      expiresIn: token.expires_in,
    }
    const json = JSON.stringify(connection).replaceAll("<", "\\u003c")
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" })
      .end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Clankwerk sign-in</title><p>Completing connection in Clankwerk…</p><script>if(window.opener){window.opener.postMessage({type:"clankwerk-codex-connection",connection:${json}},${JSON.stringify(origin)});window.close()}else{document.body.textContent="Return to Clankwerk Settings and try again with the Connect button."}</script></html>`,
      )
    // Do not log the code or token. The receiver immediately imports it over its Access session.
    setTimeout(() => server.close(), 30_000).unref()
  } catch (error) {
    res
      .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      .end(error instanceof Error ? error.message : "Sign-in failed")
  }
})
server.listen(1455, "127.0.0.1", () => {
  console.log(`Local Codex sign-in ready. Open ${origin}/settings in your browser and select Connect ChatGPT.`)
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", `${origin}/settings`] : [`${origin}/settings`]
  spawn(opener, args, { stdio: "ignore" }).on("error", () => {})
})
setTimeout(() => {
  pending = undefined
  server.close()
}, 15 * 60_000).unref()
