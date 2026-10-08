import { refreshToken } from "@octokit/oauth-methods"

export const callback = "https://clankwerk.leostera.dev/auth/github/redirect"

/** Match an instance's registered callback exactly; never trust an arbitrary returnTo query parameter. */
export function registeredReturnTo(value: string, registered: string): string {
  const candidate = new URL(value)
  const expected = new URL(registered)
  if (
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    candidate.search ||
    candidate.href !== expected.href
  )
    throw new Error("Unregistered return URL")
  return candidate.href
}
const enc = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}
export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0))
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))))
}
export async function refreshGitHubToken(refresh: string, clientId: string, clientSecret: string) {
  if (!/^ghr_[A-Za-z0-9_]{20,512}$/.test(refresh)) throw new Error("Invalid refresh credential")
  const { data } = await refreshToken({ clientType: "github-app", clientId, clientSecret, refreshToken: refresh })
  if (
    !data.access_token?.startsWith("ghu_") ||
    !data.refresh_token?.startsWith("ghr_") ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in < 60 ||
    !Number.isFinite(data.refresh_token_expires_in) ||
    data.refresh_token_expires_in < 60
  )
    throw new Error("GitHub did not rotate an expiring App user token")
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    refreshExpiresAt: Date.now() + data.refresh_token_expires_in * 1000,
  }
}

export async function exchangeGitHubCode(code: string, verifier: string, clientId: string, clientSecret: string) {
  const result = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!result.ok) throw new Error("GitHub token exchange failed")
  const token = (await result.json()) as Record<string, unknown>
  if (
    typeof token.access_token !== "string" ||
    !token.access_token.startsWith("ghu_") ||
    typeof token.refresh_token !== "string" ||
    !token.refresh_token.startsWith("ghr_") ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in < 60
  )
    throw new Error("GitHub did not return an expiring App user token")
  const identity = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "clankwerk-connect",
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!identity.ok) throw new Error("Could not verify GitHub account")
  const account = (await identity.json()) as Record<string, unknown>
  if (
    !Number.isSafeInteger(account.id) ||
    typeof account.login !== "string" ||
    !/^[a-zA-Z0-9-]{1,39}$/.test(account.login)
  )
    throw new Error("Invalid GitHub identity")
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    accountId: account.id as number,
    login: account.login as string,
  }
}
