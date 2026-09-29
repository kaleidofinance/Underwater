import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { isZcashAddress, zcashAddressKind } from "../server/zaddr.ts";

// Independent encoders, written from BIP-173/350 and base58check, to mint addresses to check against.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const sha = (b: Buffer) => createHash("sha256").update(b).digest();

function base58check(prefix: string, payload: Buffer): string {
  const body = Buffer.concat([Buffer.from(prefix, "hex"), payload]);
  const full = Buffer.concat([body, sha(sha(body)).subarray(0, 4)]);
  let n = BigInt(`0x${full.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
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

function bech(hrp: string, data: Buffer, m: boolean): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  const pm = polymod([...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31), ...words, 0, 0, 0, 0, 0, 0]) ^ (m ? 0x2bc830a3 : 1);
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...sum].map((w) => B32[w]).join("")}`;
}

const t1 = base58check("1cb8", randomBytes(20));
const t3 = base58check("1cbd", randomBytes(20));
const zs = bech("zs", randomBytes(43), false);
const u = bech("u", randomBytes(107), true);
const tex = bech("tex", randomBytes(20), true);

test("accepts every mainnet kind, checksum and all", () => {
  assert.match(t1, /^t1/);
  assert.match(t3, /^t3/);
  assert.equal(zcashAddressKind(t1), "transparent");
  assert.equal(zcashAddressKind(t3), "transparent");
  assert.equal(zcashAddressKind(zs), "sapling");
  assert.equal(zcashAddressKind(u), "unified");
  assert.equal(zcashAddressKind(tex), "tex");
  assert.equal(zcashAddressKind(`  ${u.toUpperCase()}  `), "unified", "bech32 is case-insensitive when not mixed");
});

test("refuses typos, testnet, wrong encodings and junk", () => {
  const typo = (a: string) => a.slice(0, 10) + (a[10] === "q" ? "p" : "q") + a.slice(11);
  for (const a of [t1, zs, u, tex]) assert.equal(isZcashAddress(typo(a)), false, `typo in ${a.slice(0, 4)}`);
  assert.throws(() => zcashAddressKind(bech("utest", randomBytes(107), true)), /testnet/);
  assert.throws(() => zcashAddressKind(bech("ztestsapling", randomBytes(43), false)), /testnet/);
  assert.throws(() => zcashAddressKind(base58check("1d25", randomBytes(20))), /testnet/); // tm…
  assert.equal(isZcashAddress(bech("u", randomBytes(107), false)), false, "unified must be bech32m");
  assert.equal(isZcashAddress(bech("zs", randomBytes(43), true)), false, "sapling must be bech32");
  assert.equal(isZcashAddress(bech("zs", randomBytes(42), false)), false, "sapling is 43 bytes");
  assert.equal(isZcashAddress(base58check("1cb8", randomBytes(19))), false);
  assert.equal(isZcashAddress(`${u.slice(0, 20)}${u.slice(20, 30).toUpperCase()}${u.slice(30)}`), false, "mixed case");
  for (const junk of ["", "hello", "0xabc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"]) assert.equal(isZcashAddress(junk), false, junk);
});
