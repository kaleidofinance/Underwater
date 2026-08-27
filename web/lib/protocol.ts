"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { factoryAbi, pairAbi } from "./abis";
import { useDex, usePoolQuotes, type PoolQuote } from "./dex";
import { useListings, type Listing } from "./hooks";

/**
 * The protocol's cut of DEX swap fees, read back as redeemable value.
 *
 * The V2 fee switch (`factory.feeTo`) does not pay ETH: it mints LP tokens to
 * `feeTo` on the next liquidity event, sized to ⅙ of the fee growth since the
 * last one (`UnderwaterPair._mintFee`). Graduated pools have their base
 * liquidity burned to dead, so nobody is adding or removing — which means the
 * accrued cut sits *unminted* until a pool is poked. This hook reads both
 * halves: the LP already minted to `feeTo` (`balanceOf`), and the amount a
 * liquidity event would mint right now (the same √k-vs-`kLast` formula, run
 * off-chain), then values the sum in ETH at the pool's current price.
 *
 * It reads across *every* graduated pool, not one wallet's holdings, so it is
 * owner-only by nature — callers gate it on `connected === feeTo`.
 */

const ZERO = "0x0000000000000000000000000000000000000000";

/** Integer square root (Babylonian), mirroring the pair's on-chain `sqrt`. */
function isqrt(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export type ProtocolPool = {
  token: Address;
  name: string;
  symbol: string;
  metadataURI: string;
  pair: Address;
  ethReserve: bigint;
  tokenReserve: bigint;
  /** LP already minted to feeTo, redeemable now. */
  realizedLp: bigint;
  /** LP a liquidity event would mint right now — accrued but not yet minted. */
  pendingLp: bigint;
  /** realizedLp + pendingLp. */
  claimableLp: bigint;
  /** ETH leg of redeeming claimableLp. */
  ethOut: bigint;
  /** Token leg of redeeming claimableLp. */
  tokenOut: bigint;
  /** ETH-equivalent of the whole claim (both legs), at the pool's price. */
  ethValue: bigint;
  /** kLast != 0 — the fee meter has a baseline and is accruing. */
  armed: boolean;
};

/** The factory's current protocol-fee recipient, or undefined when off. */
export function useProtocolFeeTo(): Address | undefined {
  const { factory } = useDex();
  const { data } = useReadContract({
    address: factory,
    abi: factoryAbi,
    functionName: "feeTo",
    // Mutable (the owner can move it), so not cached for the session like the
    // rest of the DEX config — but soft enough to hold for a minute.
    query: { enabled: !!factory, staleTime: 60_000 },
  });
  return typeof data === "string" && data !== ZERO ? (data as Address) : undefined;
}

/**
 * Accrued protocol fees per graduated pool, plus their ETH-valued total.
 *
 * Heavy — a market read plus three reads per graduated pair — so mount it only
 * when the owner is actually looking (the Profile page renders it behind an
 * owner-gated tab rather than unconditionally).
 */
export function useProtocolFees() {
  const feeTo = useProtocolFeeTo();
  const { listings, isLoading: listingsLoading } = useListings();

  // Every graduated pool, protocol-wide — the fee accrues across all of them,
  // not just the connected wallet's own launches.
  const graduated = useMemo(
    () => listings.filter((l) => l.pool.graduated),
    [listings],
  );
  const tokens = useMemo(() => graduated.map((l) => l.token), [graduated]);
  const { quotes } = usePoolQuotes(tokens);

  // Pair each graduated listing with its resolved pool, dropping any whose pair
  // read has not landed yet so the per-pair read indices stay aligned.
  const rows = useMemo(() => {
    const acc: { listing: Listing; quote: PoolQuote }[] = [];
    graduated.forEach((l) => {
      const quote = quotes[l.token.toLowerCase()];
      if (quote) acc.push({ listing: l, quote });
    });
    return acc;
  }, [graduated, quotes]);

  const {
    data: extra,
    isLoading: extraLoading,
  } = useReadContracts({
    contracts: rows.flatMap(({ quote }) => [
      { address: quote.pair, abi: pairAbi, functionName: "totalSupply" } as const,
      { address: quote.pair, abi: pairAbi, functionName: "kLast" } as const,
      {
        address: quote.pair,
        abi: pairAbi,
        functionName: "balanceOf",
        args: feeTo ? [feeTo] : undefined,
      } as const,
    ]),
    query: { enabled: !!feeTo && rows.length > 0, refetchInterval: 12_000 },
  });

  const pools = useMemo<ProtocolPool[]>(() => {
    if (!extra) return [];
    const out: ProtocolPool[] = [];
    rows.forEach(({ listing, quote }, i) => {
      const totalSupply = extra[i * 3]?.result as bigint | undefined;
      const kLast = extra[i * 3 + 1]?.result as bigint | undefined;
      const realizedLp = (extra[i * 3 + 2]?.result as bigint | undefined) ?? 0n;
      if (totalSupply === undefined || totalSupply === 0n) return;

      const { ethReserve, tokenReserve } = quote;

      // _mintFee: with a baseline (kLast != 0) a liquidity event mints feeTo a
      // cut of the √k growth since. Without one — the fee only just switched on —
      // nothing is owed yet; the next event sets the baseline and arms the meter.
      let pendingLp = 0n;
      const armed = kLast !== undefined && kLast !== 0n;
      if (kLast !== undefined && kLast !== 0n) {
        const rootK = isqrt(ethReserve * tokenReserve);
        const rootKLast = isqrt(kLast);
        if (rootK > rootKLast) {
          pendingLp = (totalSupply * (rootK - rootKLast)) / (rootK * 5n + rootKLast);
        }
      }

      const claimableLp = realizedLp + pendingLp;
      // Redeeming L of a T-supply pool returns L/T of each reserve. The token
      // leg values back to the ETH leg at the pool price, so the ETH-equivalent
      // of a balanced LP claim is simply twice the ETH leg.
      const ethOut = (claimableLp * ethReserve) / totalSupply;
      const tokenOut = (claimableLp * tokenReserve) / totalSupply;
      const ethValue = ethOut * 2n;

      out.push({
        token: listing.token,
        name: listing.name,
        symbol: listing.symbol,
        metadataURI: listing.metadataURI,
        pair: quote.pair,
        ethReserve,
        tokenReserve,
        realizedLp,
        pendingLp,
        claimableLp,
        ethOut,
        tokenOut,
        ethValue,
        armed,
      });
    });
    // Biggest claim first.
    out.sort((a, b) => (a.ethValue < b.ethValue ? 1 : a.ethValue > b.ethValue ? -1 : 0));
    return out;
  }, [extra, rows]);

  const totalEthValue = useMemo(
    () => pools.reduce((sum, p) => sum + p.ethValue, 0n),
    [pools],
  );
  const armedCount = useMemo(() => pools.filter((p) => p.armed).length, [pools]);

  return {
    feeTo,
    pools,
    totalEthValue,
    armedCount,
    graduatedCount: graduated.length,
    isLoading: listingsLoading || (rows.length > 0 && extraLoading && !extra),
  };
}
