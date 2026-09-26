/**
 * In-browser check of a proof of liabilities (zec/engine/solvency.ts).
 * The hashing must match the server's byte for byte, so these helpers
 * rebuild the exact strings it hashes. The point is that the user's own
 * browser does the arithmetic and trusts nothing the server claims.
 */
import type { ZecProof } from "./api";

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyLiabilityProof(p: ZecProof): Promise<boolean> {
  let hash = await sha256(`uwzec:liability:v1|${p.snapshot}|${p.leaf.id}|${p.leaf.amount}`);
  let sum = BigInt(p.leaf.amount);
  for (const step of p.path) {
    const s = BigInt(step.sum);
    if (s < 0n) return false;
    hash =
      step.side === "right"
        ? await sha256(`uwzec:node:v1|${hash}|${sum}|${step.hash}|${s}`)
        : await sha256(`uwzec:node:v1|${step.hash}|${s}|${hash}|${sum}`);
    sum += s;
  }
  return hash === p.root.hash && sum === BigInt(p.root.sum);
}
