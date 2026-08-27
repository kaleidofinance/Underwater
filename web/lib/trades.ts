"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address } from "viem";
import { usePublicClient } from "wagmi";
import { spotPriceE18 } from "./curve";
import { usePoolQuote, type PoolQuote } from "./dex";
import {
  SWAP_EVENT,
  SYNC_EVENT,
  TRADE_EVENT,
  type SwapArgs,
  type SyncArgs,
  type TradeArgs,
} from "./events";
import { useLaunchpad } from "./hooks";

/**
 * One token's trades, from both venues, read straight from the logs.
 *
 * A token's history does not end at graduation, it changes address: the curve
 * stops emitting `Trade` and the pair starts emitting `Swap`. Reading only the
 * launchpad would make a graduated token look abandoned at the busiest moment of
 * its life, so both sources are merged into one feed and labelled.
 *
 * This is a hook rather than something the trade list owns because the chart and
 * the list are the same data seen twice — one as a line, one as rows, with the
 * same filters applying to both. The page reads the feed once and hands it to
 * both, so a "load older" in the list also lengthens the chart, and neither
 * component can be looking at a different history than the other.
 *
 * There is no indexer yet, so this is a bounded `eth_getLogs` scan against
 * whatever RPC the wallet is on. Public RPCs cap the block range, so we ask for
 * a wide window first and fall back to a narrow one rather than showing an
 * error — and the feed reports the window it actually got, so the list never
 * pretends to be the full history.
 */

/** Windows to try, in blocks. `deeper()` walks down this list. */
const DEPTHS = [100_000n, 500_000n, 2_500_000n] as const;
/** What almost every public RPC will serve when the wide window is refused. */
const NARROW = 9_000n;
/** Bound on rows held in memory. Pagination pages within this, not past it. */
const ROWS = 240;
/**
 * Blocks to fetch per pass while recovering pool timestamps. Blocks are
 * immutable, so anything already fetched is free on the next pass and the
 * remainder catches up over the following refetches rather than in one burst.
 */
const STAMP_BUDGET = 64;

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

export type TradeFeed = {
  trades: Trade[];
  /** Blocks actually covered, and whether that reaches the start of the chain. */
  window: bigint;
  complete: boolean;
  /** True when a wider window is worth offering. */
  canDeepen: boolean;
  deeper: () => void;
  isLoading: boolean;
  error: unknown;
};

export function useTradeFeed(
  token: Address | undefined,
  graduated: boolean,
): TradeFeed {
  const { address: launchpad, configured, chainId } = useLaunchpad();
  const client = usePublicClient();
  const { quote: pair } = usePoolQuote(token, graduated);
  const [depth, setDepth] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "trades",
      chainId,
      launchpad,
      token,
      pair?.pair ?? "no-pair",
      depth,
    ],
    enabled: configured && !!client && !!launchpad && !!token,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!client || !launchpad || !token) return empty;
      const latest = await client.getBlockNumber();
      // Anvil starts at block 0 and has no range cap, so scan the whole chain.
      const wide = chainId === 31337 ? latest : DEPTHS[depth];
      const windows = wide > NARROW ? [wide, NARROW] : [wide];

      let lastError: unknown;
      for (const span of windows) {
        const from = span >= latest ? 0n : latest - span;
        try {
          const trades = await scan(client, {
            launchpad,
            token,
            pair,
            from,
            to: latest,
          });
          return {
            trades,
            window: latest - from,
            complete: from === 0n,
            /** Whether the *wide* window was the one that worked. */
            wide: span === wide,
          };
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },
  });

  const deeper = useCallback(
    () => setDepth((d) => Math.min(d + 1, DEPTHS.length - 1)),
    [],
  );

  return {
    trades: data?.trades ?? [],
    window: data?.window ?? 0n,
    complete: data?.complete ?? false,
    // Only worth offering when there is more chain to look at *and* the RPC is
    // willing to serve a wide range at all — if the scan fell back to the narrow
    // window, asking for a wider one would just fall back again.
    canDeepen:
      !!data && !data.complete && data.wide && depth < DEPTHS.length - 1,
    deeper,
    isLoading,
    error,
  };
}

const empty = {
  trades: [] as Trade[],
  window: 0n,
  complete: false,
  wide: true,
};

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

async function scan(
  client: Client,
  q: {
    launchpad: Address;
    token: Address;
    pair: PoolQuote | undefined;
    from: bigint;
    to: bigint;
  },
): Promise<Trade[]> {
  const range = { fromBlock: q.from, toBlock: q.to } as const;
  const { pair } = q;

  const [curve, swaps, syncs] = await Promise.all([
    client.getLogs({
      address: q.launchpad,
      event: TRADE_EVENT,
      args: { token: q.token },
      ...range,
    }),
    pair
      ? client.getLogs({ address: pair.pair, event: SWAP_EVENT, ...range })
      : [],
    pair
      ? client.getLogs({ address: pair.pair, event: SYNC_EVENT, ...range })
      : [],
  ]);

  const reserves = syncIndex(syncs, pair);
  const rows = [
    ...curve.map(curveRow),
    ...(pair ? swaps.map((log) => poolRow(log, pair, reserves)) : []),
  ]
    // Ordered by position on chain, not by timestamp: `Swap` carries no
    // timestamp of its own, and (block, logIndex) is exact anyway.
    .sort((a, b) =>
      a.block === b.block ? b.logIndex - a.logIndex : b.block > a.block ? 1 : -1,
    )
    .slice(0, ROWS);

  await stampPoolRows(client, rows);
  return rows;
}

type LogLike = {
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

function curveRow(log: LogLike): Trade {
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
function syncIndex(logs: LogLike[], pair: PoolQuote | undefined) {
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
 * address — the trader is recovered from the transaction sender instead, in
 * `stampPoolRows`.
 */
function poolRow(
  log: LogLike,
  pair: PoolQuote,
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

/**
 * Fills in what a `Swap` log does not carry: when it happened, and who sent it.
 *
 * Both come out of the block, so this fetches the blocks the displayed pool rows
 * landed in — with their transactions, which is where the trader's address is —
 * and nothing else. Blocks are immutable, so results are cached for the session
 * and a refetch only ever pays for blocks it has not seen. A few at a time,
 * because public RPCs rate-limit bursts.
 */
const blockCache = new Map<
  string,
  { at: number; senders: Map<string, Address> }
>();

async function stampPoolRows(client: Client, rows: Trade[]) {
  const wanted = [
    ...new Set(rows.filter((r) => r.venue === "pool").map((r) => r.block)),
  ];
  const missing = wanted
    .filter((block) => !blockCache.has(`${client.chain?.id}:${block}`))
    // Newest first, and only so many per pass: a deep scan can turn up more
    // pool blocks than it is reasonable to ask an RPC for in one go, and the
    // rows nobody has scrolled to yet can wait for the next refetch.
    .sort((a, b) => (a > b ? -1 : 1))
    .slice(0, STAMP_BUDGET);

  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (blockNumber) => {
        const block = await client.getBlock({
          blockNumber,
          includeTransactions: true,
        });
        const senders = new Map<string, Address>();
        for (const tx of block.transactions) {
          if (typeof tx !== "string") senders.set(tx.hash.toLowerCase(), tx.from);
        }
        blockCache.set(`${client.chain?.id}:${blockNumber}`, {
          at: Number(block.timestamp),
          senders,
        });
      }),
    );
  }

  for (const row of rows) {
    if (row.venue !== "pool") continue;
    const block = blockCache.get(`${client.chain?.id}:${row.block}`);
    if (!block) continue;
    row.timestamp = block.at;
    row.trader = block.senders.get(row.txHash.toLowerCase()) ?? row.trader;
  }
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/// ─── Filtering, shared by the chart and the list ───────────────────────────

export type TradeFilter = {
  side: "all" | "buy" | "sell";
  venue: "all" | "curve" | "pool";
  /** Only trades sent by this address, when set. */
  mine: Address | null;
  /** Free text: an address, a transaction hash, or any prefix of either. */
  query: string;
};

export const NO_FILTER: TradeFilter = {
  side: "all",
  venue: "all",
  mine: null,
  query: "",
};

export function filterTrades(trades: Trade[], f: TradeFilter): Trade[] {
  const needle = f.query.trim().toLowerCase();
  return trades.filter((t) => {
    if (f.side === "buy" && !t.isBuy) return false;
    if (f.side === "sell" && t.isBuy) return false;
    if (f.venue !== "all" && t.venue !== f.venue) return false;
    if (f.mine && t.trader.toLowerCase() !== f.mine.toLowerCase()) return false;
    if (
      needle &&
      !t.trader.toLowerCase().includes(needle) &&
      !t.txHash.toLowerCase().includes(needle)
    )
      return false;
    return true;
  });
}

/** True when this filter is doing anything, so the UI can offer to clear it. */
export function isFiltered(f: TradeFilter): boolean {
  return (
    f.side !== "all" || f.venue !== "all" || !!f.mine || f.query.trim() !== ""
  );
}

/** Oldest-first, which is the order a chart needs. The feed itself is newest-first. */
export function chronological(trades: Trade[]): Trade[] {
  return trades
    .slice()
    .sort((a, b) =>
      a.block === b.block
        ? a.logIndex - b.logIndex
        : a.block > b.block
          ? 1
          : -1,
    );
}
