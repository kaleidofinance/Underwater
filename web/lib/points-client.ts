"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { pointsAbi } from "./abis";
import { useHydratedChainId } from "./hydration";
import {
  NO_COUNTS,
  pointsFor,
  RATES_FALLBACK,
  type PointCounts,
  type Rates,
} from "./points";

/**
 * The browser's side of uwPoints.
 *
 * Separate from lib/points.ts because that module is imported by `/api/points`,
 * and a `"use client"` module imported from a route handler yields a client
 * reference rather than the function — the failure `PLATES` in lib/contracts.ts
 * documents. So: arithmetic and types there, hooks here.
 *
 * Nothing in this file counts anything. The counting is a whole-history log scan
 * and a leaderboard build, which is `/api/points`' job for the reasons its docblock
 * gives; this reads that answer and the two owner-only writes.
 */

/** What the card renders. Strings from the route, parsed back to bigint here. */
export type PointsProfile = {
  counts: PointCounts;
  points: {
    registration: bigint;
    referral: bigint;
    creation: bigint;
    trading: bigint;
    granted: bigint;
    total: bigint;
  };
  rates: Rates;
  /// False when no points contract is deployed on this chain, so the card can
  /// label the rates indicative rather than quoting them as settled.
  ratesOnChain: boolean;
  /// 1-based, or null when the board could not be built or is over its limit.
  rank: number | null;
  /// How many addresses the rank is out of. Null whenever `rank` is.
  rankOf: number | null;
  /// True when a log range could not be read, so a total may be short.
  partial: boolean;
};

type Wire = {
  counts: PointCounts;
  points: Record<keyof PointsProfile["points"], string>;
  rates: Record<keyof Rates, string>;
  ratesOnChain: boolean;
  rank: number | null;
  rankOf: number | null;
  partial: boolean;
};

/**
 * One address's points, rank and breakdown.
 *
 * `refetchInterval` is deliberately slow and deliberately not tied to the chain
 * head. lib/refresh.ts invalidates contract reads on every new block, which is
 * right for a price and wrong for this: the route's own cache window is a minute,
 * so asking per block would be sixty requests to be told the same number, and the
 * number only moves when this wallet acts.
 */
export function usePoints(account?: Address) {
  const chainId = useHydratedChainId();
  const { address: connected } = useAccount();
  const who = account ?? connected;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["points", chainId, who?.toLowerCase()],
    enabled: !!who && chainId !== undefined,
    refetchInterval: 60_000,
    staleTime: 45_000,
    queryFn: async (): Promise<PointsProfile> => {
      const res = await fetch(`/api/points?address=${who}&chain=${chainId}`);
      if (!res.ok) throw new Error(`points ${res.status}`);
      const wire = (await res.json()) as Wire;

      return {
        counts: wire.counts,
        points: {
          registration: BigInt(wire.points.registration),
          referral: BigInt(wire.points.referral),
          creation: BigInt(wire.points.creation),
          trading: BigInt(wire.points.trading),
          granted: BigInt(wire.points.granted),
          total: BigInt(wire.points.total),
        },
        rates: {
          register: BigInt(wire.rates.register),
          referral: BigInt(wire.rates.referral),
          create: BigInt(wire.rates.create),
          swap: BigInt(wire.rates.swap),
        },
        ratesOnChain: wire.ratesOnChain,
        rank: wire.rank,
        rankOf: wire.rankOf,
        partial: wire.partial,
      };
    },
  });

  return { profile: data, isLoading, error, refetch };
}

/** The points contract on the connected chain, or null. */
export function usePointsContract() {
  const chainId = useHydratedChainId();
  const address = pointsFor(chainId);
  return { address, chainId, configured: address !== null };
}

/**
 * The rate card straight from the chain, for the owner panel.
 *
 * Read here rather than taken from `usePoints` because the owner editing rates
 * needs the contract's current values even when no address has been scored, and
 * because a form initialised from a route's cached copy would fight the user's
 * typing for the first minute.
 */
export function useRateCard() {
  const { address, configured } = usePointsContract();

  const { data, refetch } = useReadContract({
    address: address ?? undefined,
    abi: pointsAbi,
    functionName: "rateCard",
    query: { enabled: configured, refetchInterval: 30_000 },
  });

  const rates = useMemo<Rates>(() => {
    const card = data?.[0] as Rates | undefined;
    return card
      ? {
          register: card.register,
          referral: card.referral,
          create: card.create,
          swap: card.swap,
        }
      : RATES_FALLBACK;
  }, [data]);

  return {
    rates,
    version: (data?.[1] as bigint | undefined) ?? 0n,
    onChain: !!data,
    refetch,
  };
}

/** True when the connected wallet owns the points contract. */
export function usePointsOwner() {
  const { address: connected } = useAccount();
  const { address, configured } = usePointsContract();

  const { data: owner } = useReadContract({
    address: address ?? undefined,
    abi: pointsAbi,
    functionName: "owner",
    query: { enabled: configured, staleTime: 60_000 },
  });

  return {
    owner: owner as Address | undefined,
    isOwner:
      !!connected &&
      !!owner &&
      (owner as Address).toLowerCase() === connected.toLowerCase(),
  };
}

/** `redeem(code)` — the one write a visitor makes against this contract. */
export function useRedeem() {
  const { address } = usePointsContract();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();

  const redeem = (code: string) => {
    if (!address) return;
    writeContract({
      address,
      abi: pointsAbi,
      functionName: "redeem",
      args: [code],
    });
  };

  return { redeem, hash, isPending, error, reset };
}

/**
 * The owner writes the console needs: re-price everything, mint codes, retire codes.
 *
 * `grant` is deliberately not here. It adds points to an address for a reason typed
 * into calldata, which is the escape hatch for the cases a coupon cannot express —
 * a bounty, a mistake being made good — and those are judged one at a time and sent
 * from a terminal, the way collecting the protocol fee is. A button for it would be
 * a button whose whole job is arbitrary issuance.
 */
export function usePointsAdmin() {
  const { address } = usePointsContract();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();

  return {
    hash,
    isPending,
    error,
    reset,
    setRates: (rates: Rates) => {
      if (!address) return;
      writeContract({
        address,
        abi: pointsAbi,
        functionName: "setRates",
        args: [rates],
      });
    },
    issue: (
      codeHashes: `0x${string}`[],
      points: bigint,
      uses: number,
      boundTo: Address,
    ) => {
      if (!address) return;
      writeContract({
        address,
        abi: pointsAbi,
        functionName: "issue",
        args: [codeHashes, points, uses, boundTo],
      });
    },
    voidCodes: (codeHashes: `0x${string}`[]) => {
      if (!address) return;
      writeContract({
        address,
        abi: pointsAbi,
        functionName: "void",
        args: [codeHashes],
      });
    },
  };
}

/** An empty profile, for the loading and not-deployed states. */
export const NO_PROFILE: PointsProfile = {
  counts: NO_COUNTS,
  points: {
    registration: 0n,
    referral: 0n,
    creation: 0n,
    trading: 0n,
    granted: 0n,
    total: 0n,
  },
  rates: RATES_FALLBACK,
  ratesOnChain: false,
  rank: null,
  rankOf: null,
  partial: false,
};
