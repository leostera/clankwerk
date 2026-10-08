const enc = new TextEncoder()

/** Sign an instance-to-service request. Keep this key in the instance Worker, never in browser or code Sandbox. */
export async function signInstanceRequest(
  body: string,
  secret: string,
  timestamp = Date.now(),
): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const hash = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)))
  return {
    "content-type": "application/json",
    "x-clankwerk-timestamp": String(timestamp),
    "x-clankwerk-signature": Array.from(hash, (n) => n.toString(16).padStart(2, "0")).join(""),
  }
}

export async function verifyInstanceRequest(
  request: Request,
  secret: string | undefined,
  body: Uint8Array,
): Promise<boolean> {
  if (!secret || secret.length < 32) return false
  const timestamp = request.headers.get("x-clankwerk-timestamp")
  const signature = request.headers.get("x-clankwerk-signature")
  if (
    !timestamp ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 60_000 ||
    !signature ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ])
  const expected = Uint8Array.from(signature.match(/../g)!, (pair) => parseInt(pair, 16))
  return crypto.subtle.verify("HMAC", key, expected, enc.encode(`${timestamp}.` + new TextDecoder().decode(body)))
}
