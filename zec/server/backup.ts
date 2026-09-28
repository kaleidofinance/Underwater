/**
 * Encrypted backups: sealed to a public key, so the servers that make them
 * can never read them back, and a stolen copy is useless without the
 * private key the operator keeps offline.
 *
 * The scheme is a sealed box, and the wallet service (Rust, `ring`)
 * implements the same bytes:
 *
 *   ephemeral X25519 key pair; shared = X25519(ephemeral, recipient)
 *   key    = HKDF-SHA256(ikm = shared, salt = epk || recipient, info = INFO), 32 bytes
 *   ct     = AES-256-GCM(key, 12-byte random nonce, aad = INFO), tag appended
 *   sealed = { v: 1, epk, nonce, ct }, all base64url
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

const INFO = Buffer.from("uwzec-backup-v1");

export interface Sealed {
  readonly v: 1;
  readonly epk: string;
  readonly nonce: string;
  readonly ct: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

const publicKeyObject = (raw: Uint8Array) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: b64(raw) }, format: "jwk" });

/** A fresh backup key pair: the public half goes on the servers, the private half offline. */
export function generateBackupKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "jwk" }) as { x: string };
  const priv = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { publicKey: pub.x, privateKey: `${priv.d}.${priv.x}` };
}

function derive(shared: Buffer, epk: Uint8Array, recipient: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, recipient]), INFO, 32));
}

export function seal(recipientPublicKey: string, plaintext: Uint8Array): Sealed {
  const recipient = unb64(recipientPublicKey);
  if (recipient.length !== 32) throw new Error("a backup public key is 32 bytes of base64url");
  const eph = generateKeyPairSync("x25519");
  const epk = unb64((eph.publicKey.export({ format: "jwk" }) as { x: string }).x);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(recipient) });
  const key = derive(shared, epk, recipient);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(INFO);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, epk: b64(epk), nonce: b64(nonce), ct: b64(ct) };
}

/** Decrypt with the private key (`d.x`, as `generateBackupKey` writes it). Throws on any tampering. */
export function open(privateKey: string, sealed: Sealed): Buffer {
  if (sealed.v !== 1) throw new Error(`unknown backup format v${String(sealed.v)}`);
  const [d, x] = privateKey.trim().split(".");
  if (!d || !x) throw new Error("not a backup private key");
  const priv = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d, x }, format: "jwk" });
  const epk = unb64(sealed.epk);
  const shared = diffieHellman({ privateKey: priv, publicKey: publicKeyObject(epk) });
  const key = derive(shared, epk, unb64(x));
  const body = unb64(sealed.ct);
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(sealed.nonce));
  decipher.setAAD(INFO);
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}
