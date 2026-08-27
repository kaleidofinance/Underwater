import { formatUnits } from "viem";

/// Meme-token prices live around 1e-9 ETH, so `toFixed` on a float either shows
/// all zeros or unreadable exponents. These helpers pick a representation that
/// stays legible across the ~25x the curve travels.

/** Compact ETH: "0.0042", "1.35", "128" — never scientific notation. */
export function fmtEth(wei: bigint, maxDp = 4): string {
  const s = formatUnits(wei, 18);
  const n = Number(s);
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  const dp = n >= 100 ? 1 : n >= 1 ? 3 : maxDp;
  return trimZeros(n.toFixed(dp));
}

/** Price per token in gwei, which is the natural unit for this curve. */
export function fmtPriceGwei(weiPerTokenE18: bigint): string {
  const gwei = Number(formatUnits(weiPerTokenE18, 9));
  if (gwei === 0) return "0";
  if (gwei < 0.001) return gwei.toExponential(2);
  return trimZeros(gwei.toFixed(gwei >= 100 ? 1 : gwei >= 10 ? 2 : 3));
}

/** Token counts: "812.4M", "1.00B", "15,204". */
export function fmtTokens(amount: bigint, decimals = 18): string {
  const n = Number(formatUnits(amount, decimals));
  if (n === 0) return "0";
  if (n >= 1e9) return `${trimZeros((n / 1e9).toFixed(2))}B`;
  if (n >= 1e6) return `${trimZeros((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `${trimZeros((n / 1e3).toFixed(1))}K`;
  return trimZeros(n.toFixed(2));
}

export function fmtBps(bps: bigint | number): string {
  return `${trimZeros((Number(bps) / 100).toFixed(2))}%`;
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtAge(unixSeconds: bigint | number): string {
  const then = Number(unixSeconds) * 1000;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/**
 * A countdown, coarse: "6d 4h", "3h 20m", "18m", "44s".
 *
 * Two units at most, and never a bare zero. A mint deadline is read to decide
 * whether there is time to think it over, so seconds of precision on a six-day
 * window is noise — and it would force a re-render every second to stay honest.
 */
export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return `${total}s`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Parse a user-typed ETH amount to wei, tolerating "", ".5", "1,5". */
export function parseEthInput(raw: string): bigint | null {
  const cleaned = raw.trim().replace(",", ".");
  if (cleaned === "" || cleaned === ".") return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  if (frac.length > 18) return null;
  const padded = frac.padEnd(18, "0");
  try {
    return BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0");
  } catch {
    return null;
  }
}

/** Apply a slippage tolerance (in bps) as a minimum-out bound. */
export function withSlippage(amount: bigint, toleranceBps: number): bigint {
  return (amount * BigInt(10_000 - toleranceBps)) / 10_000n;
}

/**
 * Exact wei → decimal string, the inverse of {@link parseEthInput}. Unlike
 * `fmtEth` this loses no precision, so a "Max" or percentage pick round-trips to
 * the wei when it is written back into the amount field.
 */
export function fullPrecision(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Depth, 0..1, for the water gradient. The prototype drives its palette off a
 * single `--t`; here it is the curve's progress toward graduation, so a page
 * literally gets shallower and brighter as a launch fills.
 */
export function depthFromProgress(progressBps: number): number {
  return Math.min(1, Math.max(0, progressBps / 10_000));
}
