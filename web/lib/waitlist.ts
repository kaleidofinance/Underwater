"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { createPublicClient, http } from "viem";
import { useReadContracts } from "wagmi";
import { waitlistAbi } from "./abis";
import { ink, inkSepolia } from "./chains";
import { useHydratedChainId } from "./hydration";
import { waitlistFor } from "./waitlist-address";
import {
  activityVerdict,
  readActivity,
  type ActivityReads,
} from "./activity";
import type { ActivityVia as EligibilityVia } from "./activity";

/// The waitlist, per chain. A third independent deploy, alongside the launchpad
/// and the collection: it opens and closes before the collection has a root, and
/// a chain can have the collection without it — which is the state every network
/// is in once registration has closed and the tree has been published.
///
/// The table itself moved to ./waitlist-address, which has no "use client" on it:
/// `/api/points` scans this contract's logs, and "use client" is transitive, so a
/// route importing it from here would get a client reference instead of the
/// function. Re-exported so every existing caller is unaffected.
export { waitlistFor } from "./waitlist-address";

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

/// How many sent transactions make a wallet "active on Ink". Re-exported from
/// ./activity, which is where the bar lives now that the points leaderboard has to
/// apply the same one on the server — see its docblock for why a second copy would
/// be a bug.
export { MIN_INK_TXNS } from "./activity";

export type EligibilityStatus = "idle" | "checking" | "passed" | "failed" | "error";

export type Eligibility = {
  status: EligibilityStatus;
  /// Which signal cleared it — for the passed copy. null unless passed.
  via: EligibilityVia | null;
  /// Sent-transaction count per chain, once a check has landed. `undefined`
  /// means that chain's RPC did not answer this round — kept distinct from a
  /// real zero so "could not check" never reads as "no history".
  mainnetTxns: number | undefined;
  sepoliaTxns: number | undefined;
  /// Whether the wallet holds a supply or borrow position on Ink mainnet.
  /// `undefined` if that read did not answer.
  defi: boolean | undefined;
  /// Fire the check. A no-op without a connected account.
  run: () => void;
};

/**
 * A manual "are you real on Ink" check, with two ways to pass.
 *
 * The honest, keyless version of "verify activity", fired by a button rather
 * than on load. It runs two reads and passes on either one:
 *
 *  - transaction count on Ink mainnet or Ink Sepolia — a nonce is a sent-tx
 *    count, so `>= MIN_INK_TXNS` means the wallet has actually used the chain;
 *  - a supply or borrow position on Ink mainnet's lending market — one view call
 *    to the Aave pool, no indexer.
 *
 * The bar itself lives in lib/activity.ts, for the reason its docblock gives: the
 * points leaderboard applies the same bar to *referrals* on the server, and two
 * copies is how a form ends up promising one threshold while the board pays
 * another. This hook only supplies the browser's own clients and holds the state.
 *
 * It stays a signal, not a gate. The contract accepts any address and the
 * published criteria weigh referrals, so a fresh wallet can still register — the
 * button just lets someone confirm the signal instead of the page guessing at
 * mount.
 */
export function useEligibilityCheck(account: Address | undefined): Eligibility {
  const [status, setStatus] = useState<EligibilityStatus>("idle");
  const [via, setVia] = useState<EligibilityVia | null>(null);
  const [reads, setReads] = useState<ActivityReads>({
    mainnetTxns: undefined,
    sepoliaTxns: undefined,
    defi: undefined,
  });

  // A new wallet is a new question: clear a previous wallet's result so its
  // green tick cannot carry over to one nobody has checked.
  useEffect(() => {
    setStatus("idle");
    setVia(null);
    setReads({ mainnetTxns: undefined, sepoliaTxns: undefined, defi: undefined });
  }, [account]);

  const run = useCallback(() => {
    if (!account) return;
    setStatus("checking");

    readActivity(account, {
      mainnet: createPublicClient({ chain: ink, transport: http() }),
      sepolia: createPublicClient({ chain: inkSepolia, transport: http() }),
    }).then((r) => {
      setReads(r);

      // Nothing answered *about the wallet* — every read down — is "could not
      // check", not "you failed".
      const verdict = activityVerdict(r);
      if (!verdict) {
        setStatus("error");
        setVia(null);
        return;
      }

      setVia(verdict.via);
      setStatus(verdict.pass ? "passed" : "failed");
    });
  }, [account]);

  return { status, via, ...reads, run };
}
