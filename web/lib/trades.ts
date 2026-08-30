"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useLaunchpad } from "./hooks";
import { decodeFeed, type Trade } from "./scans";
import { getJson } from "./wire";

/**
 * One token's trades, from both venues, read once per chain rather than per tab.
 *
 * A token's history does not end at graduation, it changes address: the curve
 * stops emitting `Trade` and the pair starts emitting `Swap`. Reading only the
 * launchpad would make a graduated token look abandoned at the busiest moment of
 * its life, so both sources are merged into one feed and labelled. That merge, and
 * the arithmetic that turns a log into a priced row, now happens in
 * `/api/trades/[token]` — see the note there for why. The rows arrive final.
 *
 * This stays a hook rather than something the trade list owns because the chart and
 * the list are the same data seen twice — one as a line, one as rows, with the same
 * filters applying to both. The page reads the feed once and hands it to both, so the
 * two can never be looking at a different history than each other.
 *
 * There is no window to choose any more, and so no "load older": the route scans from
 * the launchpad's deployment block every time, and `complete` says whether that
 * reached far enough back to be this token's whole history. When it does not, the limit
 * is the row cap or a backfill still in progress — never the endpoint's range, and
 * never something a wider request from here would fix.
 */

/**
 * Re-exported from lib/scans.ts, where the shape moved so the route could build a
 * row without importing this `"use client"` module. Every existing importer still
 * reads it from here.
 */
export { ROWS } from "./scans";
export type { Trade };

/**
 * How often a tab asks for the feed, unchanged from the interval the scan itself ran
 * on. Deliberately above the route's ten-second window rather than below it: asking
 * twice per document buys nothing, and `useChainRefresh()` already adds a request
 * when a transaction of ours confirms — which brings the row forward to the next
 * window boundary rather than to now, for the reason the route explains.
 */
const FEED_POLL = 15_000;

export type TradeFeed = {
  trades: Trade[];
  /** Blocks actually covered, counting back from the head. */
  window: bigint;
  /** True when `trades` is this token's entire history — see `FeedState`. */
  complete: boolean;
  isLoading: boolean;
  error: unknown;
};

export function useTradeFeed(token: Address | undefined): TradeFeed {
  const { configured, chainId } = useLaunchpad();

  const { data, isLoading, error } = useQuery({
    // Lowercased for the reason `['token']` is: a link with a different checksum
    // spelling is the same history, and should not be a second cache entry.
    queryKey: ["trades", chainId, token?.toLowerCase()],
    queryFn: ({ signal }) =>
      getJson(`/api/trades/${token}?chain=${chainId}`, decodeFeed, signal),
    enabled: configured && !!token,
    refetchInterval: FEED_POLL,
  });

  return {
    trades: data?.trades ?? [],
    window: data?.window ?? 0n,
    complete: data?.complete ?? false,
    isLoading,
    error,
  };
}

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
