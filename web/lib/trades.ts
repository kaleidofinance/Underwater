"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address } from "viem";
import { useLaunchpad } from "./hooks";
import { decodeFeed, DEPTHS, type Trade } from "./scans";
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
 * filters applying to both. The page reads the feed once and hands it to both, so a
 * "load older" in the list also lengthens the chart, and neither component can be
 * looking at a different history than the other.
 *
 * There is still no indexer, so behind the route it is still a bounded
 * `eth_getLogs` scan, and the feed still reports the window it actually got so the
 * list never pretends to be the full history. What changed is who pays for it.
 */

/**
 * Re-exported from lib/scans.ts, where the shape moved so the route could build a
 * row without importing this `"use client"` module. Every existing importer still
 * reads it from here.
 */
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
  /** Blocks actually covered, and whether that reaches the start of the chain. */
  window: bigint;
  complete: boolean;
  /** True when a wider window is worth offering. */
  canDeepen: boolean;
  deeper: () => void;
  isLoading: boolean;
  error: unknown;
};

export function useTradeFeed(token: Address | undefined): TradeFeed {
  const { configured, chainId } = useLaunchpad();
  const [depth, setDepth] = useState(0);

  const { data, isLoading, error } = useQuery({
    // `depth` is in the key because it is a different document, not a different
    // view of one — and it is an index rather than a block count so that the shared
    // cache behind it holds three entries per token. Lowercased for the reason
    // `['token']` is: a link with a different checksum spelling is the same history.
    queryKey: ["trades", chainId, token?.toLowerCase(), depth],
    queryFn: ({ signal }) =>
      getJson(
        `/api/trades/${token}?chain=${chainId}&depth=${depth}`,
        decodeFeed,
        signal,
      ),
    enabled: configured && !!token,
    refetchInterval: FEED_POLL,
  });

  const deeper = useCallback(
    () => setDepth((d) => Math.min(d + 1, DEPTHS.length - 1)),
    [],
  );

  return {
    trades: data?.trades ?? [],
    window: data?.window ?? 0n,
    complete: data?.complete ?? false,
    // Only worth offering when there is more chain to look at *and* the RPC behind
    // the route was willing to serve a wide range at all — if the scan fell back to
    // its narrow window, asking for a wider one would just fall back again.
    canDeepen:
      !!data && !data.complete && data.wide && depth < DEPTHS.length - 1,
    deeper,
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
