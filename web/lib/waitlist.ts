"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useChainId, useReadContracts, useTransactionCount } from "wagmi";
import { waitlistAbi } from "./abis";
import { anvil, ink, inkSepolia } from "./chains";
import { envAddress } from "./contracts";
import { useHydratedChainId } from "./hydration";

/// The waitlist, per chain. A third independent deploy, alongside the launchpad
/// and the collection: it opens and closes before the collection has a root, and
/// a chain can have the collection without it — which is the state every network
/// is in once registration has closed and the tree has been published.
const ENV: Record<number, string | undefined> = {
  [ink.id]: process.env.NEXT_PUBLIC_WAITLIST_INK,
  [inkSepolia.id]: process.env.NEXT_PUBLIC_WAITLIST_INK_SEPOLIA,
  [anvil.id]: process.env.NEXT_PUBLIC_WAITLIST_ANVIL,
};

export function waitlistFor(chainId: number | undefined): Address | null {
  if (chainId === undefined) return null;
  return envAddress(ENV[chainId]);
}

export function useWaitlist() {
  const chainId = useHydratedChainId();
  const address = waitlistFor(chainId);
  return { address, chainId, configured: address !== null };
}

export type WaitlistState = {
  /// How many addresses have registered.
  count: bigint;
  opensAt: bigint;
  closesAt: bigint;
  /// The contract's own answer, which is the one that decides whether a
  /// registration reverts. Compared against the page's clock below.
  isOpen: boolean;
  /// The connected wallet's 1-based arrival order, or 0.
  position: bigint;
  /// When it registered, or 0.
  at: bigint;
  registered: boolean;
  /// Who referred this wallet, or the zero address. Recorded on chain; whether it
  /// counts is decided by the criteria in ALLOWLIST.md.
  referrer: Address;
  /// How many registrations this wallet brought in — the raw referral count. When
  /// the drop is oversubscribed this board is the rank, but only the qualified
  /// subset counts; the raw number here is not the rank. See ALLOWLIST.md.
  referrals: bigint;
};

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * The waitlist's state.
 *
 * Polled like the collection's, for a narrower reason: `count` moves under
 * whoever is looking at it, and the window opens and closes while somebody is
 * sitting on the page. Nothing here is settable — `opensAt` and `closesAt` are
 * immutable — but they are still read rather than configured in the frontend,
 * because a deadline typed into an env file is a deadline that can disagree with
 * the contract, and the contract is the one that reverts.
 */
export function useWaitlistState(account: Address | undefined) {
  const { address, configured } = useWaitlist();
  const common = { address: address ?? undefined, abi: waitlistAbi } as const;

  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      { ...common, functionName: "count" },
      { ...common, functionName: "opensAt" },
      { ...common, functionName: "closesAt" },
      { ...common, functionName: "isOpen" },
      {
        ...common,
        // One call for the whole panel: registered, position, time, referrer and
        // referral count. Five reads over a public RPC is five chances to paint a
        // half-populated card.
        functionName: "standingOf",
        args: account ? [account] : undefined,
      },
    ],
    query: { enabled: configured, refetchInterval: 8_000 },
  });

  const state = useMemo<WaitlistState>(() => {
    const at = <T,>(i: number, fallback: T): T =>
      (data?.[i]?.result as T | undefined) ?? fallback;
    // `standingOf` returns a tuple whose all-zero form is a real answer — "this
    // address has not registered" — not a missing read.
    const s = at<readonly [boolean, bigint, bigint, Address, bigint]>(4, [
      false,
      0n,
      0n,
      ZERO,
      0n,
    ]);
    return {
      count: at(0, 0n),
      opensAt: at(1, 0n),
      closesAt: at(2, 0n),
      isOpen: at(3, false),
      registered: s[0],
      position: s[1],
      at: s[2],
      referrer: s[3],
      referrals: s[4],
    };
  }, [data]);

  return {
    state,
    /// True once the first batch has landed. As on the mint page: every field
    /// above has a zero fallback, so a page cannot otherwise tell an empty
    /// waitlist from one it has not read yet.
    ready: data?.[0]?.status === "success",
    isLoading,
    refetch,
  };
}

export type WaitlistWindow = {
  kind: "unconfigured" | "before" | "open" | "closed";
  /// Seconds until it opens, floored at zero.
  opensIn: number;
  /// Seconds until it closes, floored at zero.
  closesIn: number;
};

export function windowOf(state: WaitlistState, now: number): WaitlistWindow {
  if (state.closesAt === 0n) {
    return { kind: "unconfigured", opensIn: 0, closesIn: 0 };
  }

  const opensIn = Math.max(0, Number(state.opensAt) - now);
  const closesIn = Math.max(0, Number(state.closesAt) - now);

  // The contract's `isOpen` decides, not the clock: a browser clock that is a
  // minute fast would otherwise disable the button while `register` would still
  // be accepted, or offer it after it would revert. The clock is only used for
  // the countdowns, where being a minute out is invisible.
  const kind = state.isOpen
    ? "open"
    : closesIn === 0
      ? "closed"
      : ("before" as const);

  return { kind, opensIn, closesIn };
}

/**
 * The window, with a clock behind it.
 *
 * Starts at zero for the same hydration reason as `usePhase`, and ticks once a
 * minute because `fmtDuration` shows minutes. `windowOf` reads a zero clock as
 * "long before it opens", which is what the all-zeros first paint says anyway.
 */
export function useWaitlistWindow(state: WaitlistState): WaitlistWindow {
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  return useMemo(() => windowOf(state, now), [now, state]);
}

export type InkActivity = {
  /// Undefined until the read lands, so the panel can tell "no history" from
  /// "not read yet" — the difference between a warning and a spinner.
  transacted: boolean | undefined;
  /// The account's transaction count on this chain. Zero for a fresh wallet.
  nonce: number | undefined;
  loading: boolean;
};

/**
 * Whether the connected wallet has ever transacted on the chain it is on.
 *
 * This is the honest, keyless version of "verify activity on Ink": a wallet's
 * nonce is its sent-transaction count, so `nonce > 0` means it has done
 * *something* here, and reads in one RPC call with no indexer and no API key.
 *
 * It is a signal shown to the registrant, not a gate. The contract accepts any
 * address and the published criteria weigh an Aave *position*, not a nonce, so a
 * fresh wallet can still register — the panel just says plainly that an empty one
 * is starting from nothing. Anything stronger (a position, a first-seen date)
 * needs an indexer this app deliberately does not depend on.
 */
export function useInkActivity(account: Address | undefined): InkActivity {
  const chainId = useChainId();
  const { data, isLoading } = useTransactionCount({
    address: account,
    chainId,
    query: { enabled: !!account },
  });

  return {
    nonce: data,
    transacted: data === undefined ? undefined : data > 0,
    loading: isLoading,
  };
}
