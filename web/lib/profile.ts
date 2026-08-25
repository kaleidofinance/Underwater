"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { memeTokenAbi } from "./abis";
import { CURVE } from "./contracts";
import { useLaunchpadConfig, useListings, type Listing } from "./hooks";

const E18 = 10n ** 18n;

/**
 * How many recent launches the profile scans. There is no on-chain index by
 * creator or holder, so "your launches" and "your positions" are found by
 * reading a window of recent launches and filtering it — `capped` (below) tells
 * the page when that window left older launches out, so it can say so rather
 * than quietly showing a partial picture.
 */
const WINDOW = 100;

/** A token you hold, with its position valued at the current spot price. */
export type Holding = Listing & {
  /** Your raw token balance, in base units. */
  balance: bigint;
  /** `balance` valued at the current spot price, in wei. */
  value: bigint;
  /** Your share of the fixed total supply, in basis points. */
  shareBps: number;
};

/**
 * Everything the /profile page reads for the connected wallet, off one listings
 * scan plus a single balance multicall.
 *
 * Both halves fall out of the same window: your launches are the ones whose pool
 * `creator` is you, your positions are the ones you hold a balance of. Nothing
 * here writes — the graduate and $WATER-claim actions come later — so it is the
 * market read, re-sliced two ways.
 */
export function useProfile() {
  const { address, isConnected } = useAccount();
  const { listings, isLoading: listingsLoading, isEmpty } = useListings(WINDOW);
  const { tokenCount } = useLaunchpadConfig();

  const me = address?.toLowerCase();

  const launches = useMemo(
    () => (me ? listings.filter((l) => l.pool.creator.toLowerCase() === me) : []),
    [listings, me],
  );

  const { data: balances, isLoading: balancesLoading } = useReadContracts({
    contracts: address
      ? listings.map(
          (l) =>
            ({
              address: l.token,
              abi: memeTokenAbi,
              functionName: "balanceOf",
              args: [address],
            }) as const,
        )
      : [],
    query: { enabled: !!address && listings.length > 0, refetchInterval: 12_000 },
  });

  const holdings = useMemo<Holding[]>(() => {
    if (!balances || !address) return [];
    const out: Holding[] = [];
    listings.forEach((l, i) => {
      const balance = balances[i]?.result as bigint | undefined;
      if (!balance || balance <= 0n) return;
      out.push({
        ...l,
        balance,
        value: (l.priceE18 * balance) / E18,
        shareBps: Number((balance * 10_000n) / CURVE.totalSupply),
      });
    });
    // Biggest position first — a wallet reads its own list top-down.
    out.sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
    return out;
  }, [balances, address, listings]);

  const portfolioValue = useMemo(
    () => holdings.reduce((sum, h) => sum + h.value, 0n),
    [holdings],
  );

  // A graduated curve zeroes `realEthRaised` (the ETH has left), so it raised
  // exactly the graduation threshold by definition; a live one is read directly.
  const raisedByYou = useMemo(
    () =>
      launches.reduce(
        (sum, l) => sum + (l.pool.graduated ? CURVE.graduationEth : l.pool.realEthRaised),
        0n,
      ),
    [launches],
  );

  return {
    address: address as Address | undefined,
    connected: isConnected && !!address,
    launches,
    holdings,
    portfolioValue,
    raisedByYou,
    isLoading: listingsLoading || balancesLoading,
    isEmpty,
    /** True when older launches fall outside the scanned window. */
    capped: tokenCount > BigInt(WINDOW),
    window: WINDOW,
  };
}
