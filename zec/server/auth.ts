/**
 * Request authentication: every account is an Ed25519 key held by the user.
 *
 * No passwords, no sessions, no database of secrets to leak. The browser
 * signs each request with WebCrypto, and the server checks the signature and
 * derives the account id from the public key. The same key later signs the
 * user's ZRC-20 transfers when tokens are withdrawn on-chain.
 *
 * Signed payload, one field per line:
 *
 *   METHOD
 *   /path?query
 *   timestamp (ms)
 *   sha256(body), hex
 *
 * Headers: x-uw-key (raw public key, base64url), x-uw-ts, x-uw-sig (base64url).
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

/** How far a request's timestamp may drift from the server clock. */
export const MAX_SKEW_MS = 30_000;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Account id: the first 20 bytes of sha256(public key), hex. Fits the engine's user-id rules. */
export function accountId(publicKey: Uint8Array): string {
  return sha256Hex(publicKey).slice(0, 40);
}

export function signingPayload(method: string, path: string, ts: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${sha256Hex(body)}`;
}

export type AuthResult = { ok: true; account: string } | { ok: false; reason: string };

/**
 * Checks signature, freshness and replay. `seen` remembers signatures inside
 * the skew window, so a captured request can't be played back.
 */
export function authenticate(
  headers: Record<string, string | undefined>,
  method: string,
  path: string,
  body: string,
  now: number,
  seen: Map<string, number>,
): AuthResult {
  const key = headers["x-uw-key"];
  const ts = headers["x-uw-ts"];
  const sig = headers["x-uw-sig"];
  if (!key || !ts || !sig) return { ok: false, reason: "missing signature headers" };

  const t = Number(ts);
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > MAX_SKEW_MS) return { ok: false, reason: "stale or bad timestamp" };

  const raw = Buffer.from(key, "base64url");
  if (raw.length !== 32) return { ok: false, reason: "bad public key" };

  let valid = false;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" });
    valid = verifySignature(null, Buffer.from(signingPayload(method, path, ts, body)), publicKey, Buffer.from(sig, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  for (const [s, expires] of seen) if (expires < now) seen.delete(s);
  if (seen.has(sig)) return { ok: false, reason: "replayed request" };
  seen.set(sig, now + 2 * MAX_SKEW_MS);

  return { ok: true, account: accountId(raw) };
}
