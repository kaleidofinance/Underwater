"use client";

import { useQuery } from "@tanstack/react-query";
import { useLaunchpad, type Listing } from "./hooks";
import { decodeVolume, type Volume } from "./scans";
import { getJson } from "./wire";

/**
 * Market-wide numbers: the stats a launchpad leads with.
 *
 * Two sources, because the launchpad only knows half of it. Curve trades are its
 * own `Trade` logs; once a token graduates its volume moves to a pair, so the pairs
 * are scanned too and both are added. Reading only the launchpad would make the
 * market look like it stops growing the moment a token succeeds.
 *
 * Both halves now come from `/api/volume`, which also resolves the pair set itself.
 * That is why this takes no arguments any more: the browser used to hand in the
 * pairs it happened to have, which made the scan's cache key depend on which slice
 * of the market list the calling component was rendering and on whether its pair
 * reads had landed yet. One number for the chain, read once, keyed on nothing but
 * the chain.
 */

/** Re-exported from lib/scans.ts, where the shape crosses the server/client line. */
export type { Volume };

/**
 * Unchanged from the interval the scan ran on, and matching the route's own window
 * rather than beating it — an all-time total is not improved by being asked for twice
 * per document.
 */
const VOLUME_POLL = 20_000;

export function useMarketVolume() {
  const { configured, chainId } = useLaunchpad();

  const { data, error } = useQuery({
    // Distinct from `['market']` in READS by the element-by-element rule — this is
    // a log scan and must not be swept up by the per-block invalidation.
    queryKey: ["market-volume", chainId],
    queryFn: ({ signal }) =>
      getJson(`/api/volume?chain=${chainId}`, decodeVolume, signal),
    enabled: configured,
    refetchInterval: VOLUME_POLL,
  });

  return { volume: data, error };
}

export type MarketTotals = {
  /** Every launch's market cap added up, curve-priced and pool-priced alike. */
  marketCap: bigint;
  graduated: number;
  live: number;
  total: number;
};

/**
 * The aggregates that need no extra reads — the market list already carries
 * everything they are made of.
 */
export function marketTotals(listings: readonly Listing[]): MarketTotals {
  let marketCap = 0n;
  let graduated = 0;
  for (const l of listings) {
    marketCap += l.marketCap;
    if (l.pool.graduated) graduated++;
  }
  return {
    marketCap,
    graduated,
    live: listings.length - graduated,
    total: listings.length,
  };
}
