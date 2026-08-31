"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { pointsAbi } from "./abis";
import { useHydratedChainId } from "./hydration";
import {
  NO_COUNTS,
  pointsFor,
  RATES_FALLBACK,
  type PointCounts,
  type PointEvent,
  type PointEventKind,
  type PointHistory,
  type Rates,
} from "./points";
import { big } from "./wire";

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
  /// True while the count is still converging — a block range not walked yet, a
  /// graduated pair not caught up, or a referral not verified yet — so a total may
  /// be low. Clears on its own; see `partial` in app/api/points/route.ts.
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

/** Rows asked for at a time, and the ceiling the route clamps to anyway. */
const HISTORY_PAGE = 40;
const HISTORY_MAX = 200;

/**
 * One wallet's points, event by event, newest first.
 *
 * Paged by asking for more rather than by a cursor. `limit` goes into the query key, so
 * "Load more" is a new fetch of a longer list and not an append — which sounds wasteful
 * and is the opposite: the route walks history backwards and keeps what it found, so the
 * second request re-serves the first page from its store and only reaches further back
 * for the difference. A cursor would buy nothing and would have to be threaded through
 * every refetch, invalidation and wallet change without ever pointing at the wrong page.
 *
 * `keepPreviousData` is what makes that invisible: the list stays on screen while the
 * longer page is in flight, so pressing the button extends a list instead of blanking it.
 *
 * Slower than {@link usePoints} on purpose. The balance is a number that wants to look
 * live; a list of things that already happened does not change unless this wallet acts,
 * and `useChainRefresh` already invalidates on a confirmed transaction of ours.
 */
export function usePointsHistory(account?: Address) {
  const chainId = useHydratedChainId();
  const { address: connected } = useAccount();
  const who = account ?? connected;
  const [limit, setLimit] = useState(HISTORY_PAGE);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["points-history", chainId, who?.toLowerCase(), limit],
    enabled: !!who && chainId !== undefined,
    refetchInterval: 90_000,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<PointHistory> => {
      const res = await fetch(
        `/api/points/history?address=${who}&chain=${chainId}&limit=${limit}`,
      );
      if (!res.ok) throw new Error(`points history ${res.status}`);
      return decodeHistory(await res.json());
    },
  });

  return {
    events: data?.events ?? [],
    /// There is older history than what is on screen.
    more: data?.more ?? false,
    /// The list is everything this wallet has ever done.
    allTime: data?.allTime ?? false,
    /// A date or a referral verdict is still being fetched.
    partial: data?.partial ?? false,
    isLoading,
    isFetching,
    error,
    loadMore: () => setLimit((n) => Math.min(HISTORY_MAX, n + HISTORY_PAGE)),
    /// True once the route's own ceiling is reached, so the button can stand down.
    atMax: limit >= HISTORY_MAX,
  };
}

/**
 * The wire back to rows, field by field.
 *
 * Explicit rather than a generic reviver, for the reason lib/wire.ts gives: `symbol` and
 * `reason` are attacker-supplied strings that can be spelled like integers, and nothing
 * at runtime can tell them from a quantity. So the numeric fields are named here and
 * `big` throws on anything that is not one, which fails the query rather than rendering
 * a confident wrong number.
 */
function decodeHistory(raw: unknown): PointHistory {
  const wire = raw as {
    events?: unknown[];
    more?: boolean;
    allTime?: boolean;
    partial?: boolean;
  };
  const events = (wire.events ?? []).map((row): PointEvent => {
    const e = row as Record<string, unknown>;
    return {
      kind: e.kind as PointEventKind,
      block: big(e.block),
      logIndex: Number(e.logIndex ?? 0),
      txHash: e.txHash as `0x${string}`,
      at: Number(e.at ?? 0),
      points: big(e.points),
      ...(e.token ? { token: e.token as Address } : {}),
      ...(e.symbol ? { symbol: String(e.symbol) } : {}),
      ...(e.referee ? { referee: e.referee as Address } : {}),
      ...(e.pending ? { pending: true } : {}),
      ...(typeof e.isBuy === "boolean" ? { isBuy: e.isBuy } : {}),
      ...(e.venue ? { venue: e.venue as "curve" | "pool" } : {}),
      ...(e.reason ? { reason: String(e.reason) } : {}),
    };
  });
  return {
    events,
    more: !!wire.more,
    allTime: !!wire.allTime,
    partial: !!wire.partial,
  };
}

/** The points contract on the connected chain, or null. */export function usePointsContract() {
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
