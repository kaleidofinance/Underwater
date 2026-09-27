/** ZEC amounts: zatoshi in, human text out, and back. */

export const ZATS = 100_000_000n;
export const TOKEN_DECIMALS = 18;
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;

/** zatoshi → "1.2345" (trailing zeros trimmed, at most `maxDp` places). */
export function fmtZec(zats: bigint | string, maxDp = 4): string {
  const z = typeof zats === "string" ? BigInt(zats) : zats;
  const neg = z < 0n;
  const abs = neg ? -z : z;
  const whole = abs / ZATS;
  const frac = (abs % ZATS).toString().padStart(8, "0").slice(0, maxDp).replace(/0+$/, "");
  const text = `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
  if (abs > 0n && text === "0") return `${neg ? "-" : ""}<0.${"0".repeat(Math.max(0, maxDp - 1))}1`;
  return `${neg ? "-" : ""}${text}`;
}

/** "1.5" → 150000000n. Null for anything that isn't a plain non-negative amount with ≤ 8 decimals. */
export function parseZec(raw: string): bigint | null {
  const s = raw.trim();
  const m = /^(\d*)(?:\.(\d{0,8}))?$/.exec(s);
  if (!m || s === "" || s === ".") return null;
  return BigInt(m[1] || "0") * ZATS + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}

/** Token base units (18 decimals) → compact "12.3M". */
export function fmtTokenAmount(units: bigint | string): string {
  const u = typeof units === "string" ? BigInt(units) : units;
  const n = Number(u / 10n ** 12n) / 1e6; // keep 6 fractional digits before going to float
  if (n === 0) return "0";
  if (n >= 1e9) return `${trim((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `${trim((n / 1e3).toFixed(1))}K`;
  return trim(n.toFixed(2));
}

/** Token base units → the exact decimal string, so "max" sells every last unit. */
export function tokenAmountExact(units: bigint | string): string {
  const u = typeof units === "string" ? BigInt(units) : units;
  const frac = (u % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${u / 10n ** 18n}${frac ? `.${frac}` : ""}`;
}

/** "1234.5" → token base units. */
export function parseTokenAmount(raw: string): bigint | null {
  const s = raw.trim();
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(s);
  if (!m || s === "" || s === ".") return null;
  return BigInt(m[1] || "0") * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

export function withSlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function shortId(s: string, n = 6): string {
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-4)}`;
}

export function fmtAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * The creator's cut of each trade, as a percentage of the trade: the trade
 * fee times the creator's share of it. 100 bps × 5000 bps → "0.5%".
 */
export function creatorCut(fees: { tradeFeeBps: string; creatorShareBps: string } | undefined): string | null {
  if (!fees) return null;
  const bps = (Number(fees.tradeFeeBps) * Number(fees.creatorShareBps)) / 10_000;
  return bps > 0 ? `${bps / 100}%` : null;
}
