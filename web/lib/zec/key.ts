/**
 * The Underwater ZEC account key: an Ed25519 key made and kept in this
 * browser. It signs every request to the ZEC API (zec/server/auth.ts), and
 * the account id is derived from its public half exactly as the server does.
 *
 * Nothing about it ever leaves the browser except signatures and the public
 * key. The one way to move it between devices is the backup string, which
 * the account page makes the user save; lose it with the browser's storage
 * and the account is gone. Kept in localStorage, so a script injected into
 * this origin could read it. That's the price of a no-login account and why
 * the backup, not the storage, is the durable copy.
 */

const STORE = "uwzec:key:v1";
const BACKUP_PREFIX = "uwzec1:";

export interface ZecKey {
  /** 40 hex chars: the first 20 bytes of sha256(public key). */
  readonly account: string;
  /** Raw public key, base64url, as sent in x-uw-key. */
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

type Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; d: string };

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fromJwk(jwk: Jwk): Promise<ZecKey> {
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["sign"]);
  const account = (await sha256Hex(b64urlToBytes(jwk.x))).slice(0, 40);
  return { account, publicKey: jwk.x, privateKey };
}

function readStore(): Jwk | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const jwk = JSON.parse(raw) as Jwk;
    return jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x && jwk.d ? jwk : null;
  } catch {
    return null;
  }
}

function writeStore(jwk: Jwk): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }));
  } catch {
    /* private mode: the key lives for this tab only, and the backup still works */
  }
}

let current: Promise<ZecKey> | null = null;

/** This browser's key, created on first use. */
export function loadOrCreateKey(): Promise<ZecKey> {
  current ??= (async () => {
    const stored = readStore();
    if (stored) return fromJwk(stored);
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk;
    writeStore(jwk);
    return fromJwk(jwk);
  })();
  return current;
}

/** The one-line backup: everything needed to restore this account anywhere. */
export async function exportBackup(): Promise<string> {
  const key = await loadOrCreateKey();
  const jwk = (await crypto.subtle.exportKey("jwk", key.privateKey)) as Jwk;
  return `${BACKUP_PREFIX}${jwk.d}.${jwk.x}`;
}

/** Replace this browser's key with a backed-up one. */
export async function importBackup(text: string): Promise<ZecKey> {
  const m = new RegExp(`^${BACKUP_PREFIX}([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})$`).exec(text.trim());
  if (!m?.[1] || !m[2]) throw new Error("That isn't an Underwater ZEC account backup.");
  const jwk: Jwk = { kty: "OKP", crv: "Ed25519", d: m[1], x: m[2] };
  const key = await fromJwk(jwk); // throws if d and x don't belong together
  writeStore(jwk);
  current = Promise.resolve(key);
  return key;
}

export async function signBytes(key: ZecKey, data: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(data)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export { sha256Hex };
