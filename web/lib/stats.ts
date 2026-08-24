"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId, usePublicClient } from "wagmi";
import type { PoolQuote } from "./dex";
import { SWAP_EVENT, swapEth, TRADE_EVENT, type SwapArgs, type TradeArgs } from "./events";
import { useLaunchpad, type Listing } from "./hooks";

/**
 * Market-wide numbers: the stats a launchpad leads with.
 *
 * Two sources, because the launchpad only knows half of it. Curve trades are its
 * own `Trade` logs; once a token graduates its volume moves to a pair, so the
 * pairs are scanned too and both are added. Reading only the launchpad would make
 * the market look like it stops growing the moment a token succeeds.
 *
 * There is no indexer yet, so this is a bounded `eth_getLogs` scan — same
 * treatment as the per-token feed: ask wide, fall back narrow, and report which
 * window actually answered so the number is never presented as all-time when it
 * is not.
 */
const WIDE = 100_000n;
const NARROW = 9_000n;

export type Volume = {
  /** ETH that changed hands, both venues, both directions. */
  eth: bigint;
  trades: number;
  /** How many blocks the scan covered. */
  blocks: bigint;
  /** True when the scan reached the genesis block, so nothing is missing. */
  allTime: boolean;
};

export function useMarketVolume(pairs: readonly PoolQuote[]) {
  const { address: launchpad, configured } = useLaunchpad();
  const chainId = useChainId();
  const client = usePublicClient();

  // Keyed on the set of pairs, not the array itself: the pair reads refetch on a
  // timer and hand back a fresh array each time, which would restart this scan
  // every few seconds for no new information.
  const key = pairs
    .map((p) => p.pair.toLowerCase())
    .sort()
    .join(",");

  const { data, error } = useQuery({
    queryKey: ["market-volume", chainId, launchpad, key],
    enabled: configured && !!client && !!launchpad,
    refetchInterval: 20_000,
    queryFn: async (): Promise<Volume> => {
      if (!client || !launchpad) throw new Error("no client");
      const latest = await client.getBlockNumber();
      // Anvil starts at block 0 and caps nothing, so scan the whole chain.
      const windows = chainId === 31337 ? [latest] : [WIDE, NARROW];

      let lastError: unknown;
      for (const span of windows) {
        const from = span >= latest ? 0n : latest - span;
        try {
          const [curve, pool] = await Promise.all([
            // No `args` filter: this is every token's trades, not one token's.
            client.getLogs({
              address: launchpad,
              event: TRADE_EVENT,
              fromBlock: from,
              toBlock: latest,
            }),
            pairs.length
              ? client.getLogs({
                  // One call for every pair at once — `eth_getLogs` takes a list
                  // of addresses, and a request per pair would not scale.
                  address: pairs.map((p) => p.pair),
                  event: SWAP_EVENT,
                  fromBlock: from,
                  toBlock: latest,
                })
              : [],
          ]);

          const wethSide = new Map(
            pairs.map((p) => [p.pair.toLowerCase(), p.wethIsToken0]),
          );

          let eth = 0n;
          for (const log of curve) {
            // The curve-side ETH, which is the trade minus its fee. Volume, not
            // revenue — the fee is counted where it is charged, not here.
            eth += (log.args as TradeArgs).ethAmount ?? 0n;
          }
          for (const log of pool) {
            const wethIsToken0 = wethSide.get(log.address.toLowerCase());
            if (wethIsToken0 === undefined) continue;
            eth += swapEth(log.args as SwapArgs, wethIsToken0);
          }

          return {
            eth,
            trades: curve.length + pool.length,
            blocks: latest - from,
            allTime: from === 0n,
          };
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    },
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
