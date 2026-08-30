import type { Address } from "viem";
import { spotPriceE18 } from "./curve";
import type { PairSide } from "./market";
import type { SwapArgs, SyncArgs, TradeArgs } from "./events";
import { big, bigOrNull, WireError } from "./wire";

/**
 * The two log scans' shapes, and the pure decoding both sides of them share.
 *
 * Same reason lib/market.ts exists: lib/trades.ts and lib/stats.ts are both
 * `"use client"`, and a route handler that imports from one gets a compiled
 * reference rather than a function. Everything here is pure — a log in, a row out —
 * so it moves to a module with no directive and the routes and the hooks both
 * import it.
 *
 * Turning a log into a row is the part worth having in exactly one place. Which leg
 * of a `Swap` is ETH depends on how the two addresses sorted when the pair was
 * created; the reserves a swap left behind are in the `Sync` the same `_update`
 * emitted just before it. Written twice, those are two chances to disagree about
 * what a trade was worth.
 */

/**
 * Bound on rows in one payload. Pagination pages within this, not past it — the
 * same cap the browser used to hold in memory, now also the cap on what crosses
 * the wire.
 */
export const ROWS = 240;

/**
 * Blocks to fetch per pass while recovering pool timestamps. Blocks are immutable,
 * so anything already fetched is free on the next pass and the remainder catches up
 * over the following reads rather than in one burst.
 */
export const STAMP_BUDGET = 64;

export type Trade = {
  key: string;
  venue: "curve" | "pool";
  isBuy: boolean;
  trader: Address;
  /** Gross ETH the trade moved, fee included. */
  ethAmount: bigint;
  tokenAmount: bigint;
  /** Curve fee paid on this trade; zero for a pool swap, which pays the pool. */
  fee: bigint;
  /** Price *after* the trade, wei per token at 1e18 — the same unit as everywhere else. */
  priceE18: bigint;
  /** ETH the curve was holding after this trade. Null for a pool swap. */
  raised: bigint | null;
  /** Null while a pool row's block timestamp is still unknown. */
  timestamp: number | null;
  block: bigint;
  logIndex: number;
  txHash: string;
};

/** One token's feed, as `/api/trades/[token]` serves it. */
export type FeedState = {
  chainId: number;
  token: Address;
  /** Newest first. */
  trades: Trade[];
  /**
   * Blocks actually covered, counting back from the head.
   *
   * Nothing renders this any more — `complete` is what a reader needs, and "the last
   * 384,000 blocks" was never a sentence anybody wanted. Kept on the wire because it
   * is the one number that says whether a truncated feed stopped ten chunks back or
   * forty, which is the difference between a busy token and a broken scan.
   */
  window: bigint;
  /**
   * Whether that reaches the launchpad's own deployment block — so every trade this
   * token has ever made is in `trades`.
   *
   * False is never the endpoint refusing a range: either the {@link ROWS} cap stopped
   * the scan short, or its backfill is still working its way back and will get there
   * over the next read or two. Both are notes about the list, never an invitation for
   * the browser to go scanning wider itself.
   */
  complete: boolean;
};

/**
 * Every lever the protocol earns on, and their sum.
 *
 * The market shows one figure, and one figure is the point: revenue is the protocol's,
 * not any one product's. A launch pays a flat creation fee, a curve trade pays
 * `tradeFeeBps` of itself, a graduation pays `graduationFeeBps` on the way out to the
 * DEX, and a pool swap pays the DEX's sixth of its 0.3%.
 *
 * Split rather than pre-summed because the legs are not equally solid and whoever reads
 * this next deserves to be able to tell which is which. Two are exact sums of what the
 * contract said it took, one is a counter times a rate, and one is derived from volume —
 * see the fields, and /api/volume for the reasoning behind each.
 *
 * Not in here: the plates mint. Its proceeds are product *sales* rather than a fee, they
 * sit in a separate deploy that a given chain may not have at all, and each mint paid
 * whatever price was in force at the time — so counting them means a scan of that
 * contract with a price timeline beside it, not a line in a launchpad total.
 */
export type Fees = {
  /**
   * Creation fees: every launch there has ever been, times the fee.
   *
   * The launchpad's own `tokenCount`, so this leg is exact and complete on the first
   * read while the log legs are still reaching backwards. Wrong only if `creationFee`
   * is ever changed, which would re-value earlier launches at the new price.
   */
  launch: bigint;
  /**
   * Curve trade fees, summed off `Trade.feeAmount` — exactly what the contract took on
   * each trade, not `eth` times today's rate. The two stop agreeing the moment the rate
   * is changed, and only one of them is revenue.
   */
  curve: bigint;
  /**
   * Graduation fees, summed off `Graduated.protocolFee`. Exact, and a shade low: the
   * launchpad pays out the fee plus the router's refund of any liquidity it could not
   * place, and the event carries only the fee. See `GRADUATED_EVENT`.
   */
  graduation: bigint;
  /**
   * The DEX's cut of pool swaps: five basis points of pool volume, which is the sixth of
   * 0.3% that `_mintFee` accrues to `feeTo`. Zero while the fee switch is off.
   *
   * The one derived leg, and cumulative on purpose. The exact figure — LP minted to
   * `feeTo` plus the √k accrual, valued at the pool's price — is what /profile's protocol
   * tab reads, because the owner is deciding whether to collect it; that number is what
   * is claimable *now* and would fall to zero once collected. This one is what was
   * earned. See `POOL_CUT_BPS` in /api/volume.
   */
  pool: bigint;
  /** All four. What the card shows. */
  total: bigint;
};

export type Volume = {
  /** ETH that changed hands, both venues, both directions. */
  eth: bigint;
  trades: number;
  /**
   * What the protocol earned on all of it, across every product — see {@link Fees}.
   *
   * Nearly free: three of the four legs are summed from logs this scan already fetches
   * for {@link Volume.eth}, on the same requests, so the fee total costs one contract
   * read on top of the volume.
   *
   * It carries the same window as `eth` with one exception in its favour: `launch` comes
   * off a contract counter rather than a range, so it is whole even while
   * {@link Volume.allTime} is false and the rest is still catching up.
   */
  fees: Fees;
  /** How many blocks the scan covered. */
  blocks: bigint;
  /**
   * True when the total covers every block from the launchpad's deployment onwards,
   * so nothing is missing.
   *
   * False while the aggregate is still reaching backwards — a freshly started server
   * counts recent trading first and the rest of history over the following reads — or,
   * permanently, if the deployment block could not be located and a fixed lookback was
   * used instead.
   */
  allTime: boolean;
};

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/* ---------------------------------------------------------------------------
 * Logs to rows.
 * ------------------------------------------------------------------------- */

export type LogLike = {
  transactionHash: string | null;
  blockNumber: bigint | null;
  logIndex: number | null;
  args: unknown;
};

function base(log: LogLike, venue: Trade["venue"]) {
  return {
    key: `${log.transactionHash}-${log.logIndex ?? 0}-${venue}`,
    venue,
    block: log.blockNumber ?? 0n,
    logIndex: log.logIndex ?? 0,
    txHash: log.transactionHash ?? "",
  };
}

export function curveRow(log: LogLike): Trade {
  const a = log.args as TradeArgs;
  return {
    ...base(log, "curve"),
    isBuy: a.isBuy ?? true,
    trader: a.trader ?? ZERO,
    ethAmount: a.ethAmount ?? 0n,
    tokenAmount: a.tokenAmount ?? 0n,
    fee: a.feeAmount ?? 0n,
    priceE18: spotPriceE18(a.ethReserve ?? 0n, a.tokenReserve ?? 0n),
    raised: a.realEthRaised ?? null,
    timestamp: Number(a.timestamp ?? 0n),
  };
}

/**
 * Post-swap reserves, keyed by the position of the log that caused them.
 *
 * The pair emits `Sync` then `Swap` from the same `_update`, so the reserves a
 * swap left behind are in the nearest preceding `Sync` — which is what makes a
 * pool price point exact instead of a realised average. Mints and burns emit
 * `Sync` too and have no swap after them; they simply never get looked up.
 */
export function syncIndex(logs: LogLike[], pair: PairSide | undefined) {
  const out: { block: bigint; logIndex: number; priceE18: bigint }[] = [];
  if (!pair) return out;
  for (const log of logs) {
    const a = log.args as SyncArgs;
    const eth = (pair.wethIsToken0 ? a.reserve0 : a.reserve1) ?? 0n;
    const tokens = (pair.wethIsToken0 ? a.reserve1 : a.reserve0) ?? 0n;
    out.push({
      block: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
      priceE18: spotPriceE18(eth, tokens),
    });
  }
  return out.sort((a, b) =>
    a.block === b.block
      ? a.logIndex - b.logIndex
      : a.block > b.block
        ? 1
        : -1,
  );
}

/** The last `Sync` at or before a position — the state that swap produced. */
function priceAt(
  index: ReturnType<typeof syncIndex>,
  block: bigint,
  logIndex: number,
): bigint | null {
  // Binary search: a deep scan can turn up thousands of syncs, and a linear
  // walk per swap would make this quadratic in the length of the history.
  const before = (i: number) =>
    index[i].block < block ||
    (index[i].block === block && index[i].logIndex <= logIndex);

  let lo = 0;
  let hi = index.length - 1;
  let found: bigint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (before(mid)) {
      found = index[mid].priceE18;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * A pair's `Swap` reports both sides of the trade in token0/token1 order, so
 * which leg is ETH depends on how the two addresses sorted when the pair was
 * created.
 *
 * `to` only identifies the trader on a buy. Selling routes the output back
 * through the router so it can unwrap WETH, which makes `to` the router's own
 * address — the trader is recovered from the transaction sender instead, when the
 * rows are stamped.
 */
export function poolRow(
  log: LogLike,
  pair: PairSide,
  reserves: ReturnType<typeof syncIndex>,
): Trade {
  const a = log.args as SwapArgs;
  const wethIsToken0 = pair.wethIsToken0;
  const ethIn = (wethIsToken0 ? a.amount0In : a.amount1In) ?? 0n;
  const ethOut = (wethIsToken0 ? a.amount0Out : a.amount1Out) ?? 0n;
  const tokenIn = (wethIsToken0 ? a.amount1In : a.amount0In) ?? 0n;
  const tokenOut = (wethIsToken0 ? a.amount1Out : a.amount0Out) ?? 0n;
  const isBuy = ethIn > 0n;
  const eth = isBuy ? ethIn : ethOut;
  const tokens = isBuy ? tokenOut : tokenIn;
  const row = base(log, "pool");

  return {
    ...row,
    isBuy,
    trader: a.to ?? ZERO,
    ethAmount: eth,
    tokenAmount: tokens,
    // A pool swap pays the pool, not the launchpad — 0.30%, kept as liquidity.
    fee: 0n,
    // Spot after the swap where the `Sync` was found, and the trade's own
    // realised rate when it was not, which is the closest honest substitute.
    priceE18:
      priceAt(reserves, row.block, row.logIndex) ??
      (tokens > 0n ? (eth * 10n ** 18n) / tokens : 0n),
    raised: null,
    timestamp: null,
  };
}

/** Newest first — position on chain, not timestamp, since `Swap` carries none. */
export function newestFirst(rows: Trade[]): Trade[] {
  return rows.sort((a, b) =>
    a.block === b.block ? b.logIndex - a.logIndex : b.block > a.block ? 1 : -1,
  );
}

/* ---------------------------------------------------------------------------
 * Decoding the wire form. Field by field, for the reason lib/wire.ts gives.
 * ------------------------------------------------------------------------- */

function fields(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function addr(value: unknown, what: string): Address {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value as Address;
  }
  throw new WireError(`${what}: expected an address`);
}

function decodeTrade(raw: unknown): Trade {
  const t = fields(raw, "trade");
  // The one field with a closed set of values, so it is checked rather than cast —
  // `filterTrades` compares against both spellings and a third would silently
  // match neither.
  if (t.venue !== "curve" && t.venue !== "pool") {
    throw new WireError("trade.venue: expected 'curve' or 'pool'");
  }
  return {
    key: typeof t.key === "string" ? t.key : "",
    venue: t.venue,
    isBuy: t.isBuy === true,
    trader: addr(t.trader, "trade.trader"),
    ethAmount: big(t.ethAmount),
    tokenAmount: big(t.tokenAmount),
    fee: big(t.fee),
    priceE18: big(t.priceE18),
    raised: bigOrNull(t.raised),
    // Null is a real answer — a pool row whose block has not been fetched yet —
    // and `Number(null)` is 0, which would render as 1970 rather than as "pending".
    timestamp:
      t.timestamp === null || t.timestamp === undefined
        ? null
        : Number(t.timestamp) || 0,
    block: big(t.block),
    logIndex: Number(t.logIndex) || 0,
    txHash: typeof t.txHash === "string" ? t.txHash : "",
  };
}

export function decodeFeed(raw: unknown): FeedState {
  const f = fields(raw, "feed");
  if (!Array.isArray(f.trades)) {
    throw new WireError("feed.trades: expected an array");
  }
  return {
    chainId: Number(f.chainId),
    token: addr(f.token, "feed.token"),
    trades: f.trades.map(decodeTrade),
    window: big(f.window),
    complete: f.complete === true,
  };
}

export function decodeVolume(raw: unknown): Volume {
  const v = fields(raw, "volume");
  return {
    eth: big(v.eth),
    trades: Number(v.trades) || 0,
    fees: decodeFees(v.fees),
    blocks: big(v.blocks),
    allTime: v.allTime === true,
  };
}

/**
 * Every leg named, `total` included rather than re-added here.
 *
 * The server is the one place that knows what the total is a total *of* — the legs it
 * could not read are zero there, and re-summing them in the browser would silently agree
 * with whatever arrived. If a leg ever goes missing from the payload this throws, which
 * is the whole argument in lib/wire.ts.
 */
function decodeFees(raw: unknown): Fees {
  const f = fields(raw, "volume.fees");
  return {
    launch: big(f.launch),
    curve: big(f.curve),
    graduation: big(f.graduation),
    pool: big(f.pool),
    total: big(f.total),
  };
}
