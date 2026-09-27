/**
 * Token taxes: a per-token levy the creator sets at launch, separate from the
 * protocol's own fees and fixed for the token's life.
 *
 * A tax has a buy rate and a sell rate, charged on the ZEC side of every
 * trade (on the curve and, after graduation, in the pool), and a split of
 * where the proceeds go, which must total 100%:
 *
 *   creator      straight into the creator's balance
 *   dividends    to every holder of the token, pro rata to their holding
 *   buyback      buys the token from its pool and burns it
 *   liquidity    added to the token's pool, deepening it
 *
 * Buyback and liquidity need a pool. While a token is still on its curve,
 * those shares accumulate and land in the pool the moment it graduates.
 */
import { BPS } from "./config.ts";
import { fail } from "./errors.ts";

export interface TokenTax {
  /** On buys, in bps of the ZEC paid. */
  readonly buyBps: bigint;
  /** On sells, in bps of the ZEC the pool pays out. */
  readonly sellBps: bigint;
  /** Where it goes, in bps of the tax. Together exactly 10,000. */
  readonly creatorBps: bigint;
  readonly dividendsBps: bigint;
  readonly buybackBps: bigint;
  readonly liquidityBps: bigint;
}

/** The most a creator can tax either side of a trade: 10%. */
export const MAX_TAX_BPS = 1_000n;

export const TAX_FIELDS = ["buyBps", "sellBps", "creatorBps", "dividendsBps", "buybackBps", "liquidityBps"] as const;

/**
 * Check a tax, and normalise one that charges nothing to null: a 0% tax is
 * no tax, whatever its split says.
 */
export function validateTax(t: TokenTax | null | undefined): TokenTax | null {
  if (!t) return null;
  for (const f of TAX_FIELDS) {
    if (typeof t[f] !== "bigint" || t[f] < 0n) fail("InvalidArgument", `tax ${f} must be a non-negative bigint`);
  }
  if (t.buyBps > MAX_TAX_BPS || t.sellBps > MAX_TAX_BPS) {
    fail("InvalidArgument", `a tax is at most ${Number(MAX_TAX_BPS) / 100}% on each side`);
  }
  if (t.buyBps === 0n && t.sellBps === 0n) return null;
  if (t.creatorBps + t.dividendsBps + t.buybackBps + t.liquidityBps !== BPS) {
    fail("InvalidArgument", "a tax's split must total 100%");
  }
  const clean: TokenTax = {
    buyBps: t.buyBps,
    sellBps: t.sellBps,
    creatorBps: t.creatorBps,
    dividendsBps: t.dividendsBps,
    buybackBps: t.buybackBps,
    liquidityBps: t.liquidityBps,
  };
  return clean;
}

export interface TaxSplit {
  readonly creator: bigint;
  readonly dividends: bigint;
  readonly buyback: bigint;
  readonly liquidity: bigint;
}

/**
 * Split `amount` by the tax's shares. Each share rounds down; the few
 * zatoshi of rounding go to the first destination that has a share, in the
 * order creator, dividends, buyback, liquidity, so the parts always sum to
 * exactly `amount`.
 */
export function splitTax(t: TokenTax, amount: bigint): TaxSplit {
  const parts = {
    creator: (amount * t.creatorBps) / BPS,
    dividends: (amount * t.dividendsBps) / BPS,
    buyback: (amount * t.buybackBps) / BPS,
    liquidity: (amount * t.liquidityBps) / BPS,
  };
  const dust = amount - parts.creator - parts.dividends - parts.buyback - parts.liquidity;
  if (dust > 0n) {
    if (t.creatorBps > 0n) parts.creator += dust;
    else if (t.dividendsBps > 0n) parts.dividends += dust;
    else if (t.buybackBps > 0n) parts.buyback += dust;
    else parts.liquidity += dust;
  }
  return parts;
}

/** Decode a tax from its JSON form (bigints as decimal strings). */
export function decodeTax(raw: unknown): TokenTax | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: Record<string, bigint> = {};
  for (const f of TAX_FIELDS) out[f] = BigInt(o[f] as string);
  return out as unknown as TokenTax;
}
