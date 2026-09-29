/**
 * Zcash mainnet address checks, checksum included, with no dependencies.
 *
 * Accepts every kind a person might paste: transparent t1/t3 (what Zord and
 * other inscription wallets give out), TEX tex1 (ZIP 320), Sapling zs1, and
 * unified u1. A typo fails the checksum here instead of losing a delivery
 * later. Testnet addresses are named as such, since pasting one by mistake is
 * the likeliest error while the app itself runs on testnet.
 */
import { createHash } from "node:crypto";

export type AddressKind = "transparent" | "tex" | "sapling" | "unified";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32 = 1;
const BECH32M = 0x2bc830a3;

/** Mainnet transparent prefixes: t1 is a key hash (P2PKH), t3 a script hash (P2SH). */
const T_PREFIXES = new Set(["1cb8", "1cbd"]);

export class AddressError extends Error {}

/** The kind of a valid mainnet address, or an AddressError saying what's wrong. */
export function zcashAddressKind(raw: string): AddressKind {
  const a = raw.trim();
  const lower = a.toLowerCase();
  if (/^(tm|t2)/.test(a) || /^(utest1|ztestsapling1|textest1)/.test(lower)) {
    throw new AddressError("that's a testnet address: use a mainnet one (t1…, u1… or zs1…)");
  }
  if (/^t[13]/.test(a)) {
    const bytes = base58(a);
    if (!bytes || bytes.length !== 26) throw new AddressError("that transparent address isn't valid");
    const body = bytes.subarray(0, 22);
    const sum = sha256(sha256(body)).subarray(0, 4);
    if (!sum.equals(bytes.subarray(22)) || !T_PREFIXES.has(body.subarray(0, 2).toString("hex"))) {
      throw new AddressError("that transparent address has a typo (its checksum doesn't match)");
    }
    return "transparent";
  }
  if (a !== lower && a !== a.toUpperCase()) throw new AddressError("an address can't mix upper and lower case");
  const b = bech32(lower);
  if (!b) throw new AddressError("that doesn't look like a Zcash address");
  if (b.hrp === "zs" && b.variant === BECH32 && b.data.length === 43) return "sapling";
  if (b.hrp === "u" && b.variant === BECH32M && b.data.length >= 48) return "unified";
  if (b.hrp === "tex" && b.variant === BECH32M && b.data.length === 20) return "tex";
  throw new AddressError("that doesn't look like a Zcash mainnet address");
}

export function isZcashAddress(raw: string): boolean {
  try {
    zcashAddressKind(raw);
    return true;
  } catch {
    return false;
  }
}

function sha256(b: Buffer): Buffer {
  return createHash("sha256").update(b).digest();
}

function base58(s: string): Buffer | null {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  const zeros = s.length - s.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i] as number;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
}

/** Decode Bech32/Bech32m (no length cap: unified addresses run past 90 characters). */
function bech32(s: string): { hrp: string; data: Buffer; variant: number } | null {
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length || s.length > 1024) return null;
  const hrp = s.slice(0, pos);
  const words: number[] = [];
  for (const c of s.slice(pos + 1)) {
    const v = B32.indexOf(c);
    if (v < 0) return null;
    words.push(v);
  }
  const variant = polymod([...hrpExpand(hrp), ...words]);
  if (variant !== BECH32 && variant !== BECH32M) return null;
  // 5-bit words → bytes, rejecting non-zero or overlong padding.
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words.slice(0, -6)) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
  return { hrp, data: Buffer.from(out), variant };
}
