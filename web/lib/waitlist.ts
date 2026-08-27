"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address, Chain } from "viem";
import { createPublicClient, http } from "viem";
import { useReadContracts } from "wagmi";
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

/// How many sent transactions make a wallet "active on Ink" — ten, a wallet
/// that has actually used the chain rather than just touched it once. It is one
/// of two ways to pass the check (a DeFi position on Ink mainnet is the other);
/// read in one place so the hook and the panel's copy cannot drift.
export const MIN_INK_TXNS = 10;

/// Ink mainnet's lending market — Aave's codebase deployed as an Ink-native
/// "whitelabel" market (bgd-labs/aave-address-book, `AaveV3InkWhitelabel`). Its
/// pool answers `getUserAccountData`, so one view call tells us whether a wallet
/// has supplied or borrowed here — a DeFi position, no indexer. A public address
/// and a plain view call, so the whole check runs from the browser: no secret,
/// and no server route to hold one.
const INK_AAVE_POOL = "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA" as const;

/// Just the one view we need off the Aave pool. Everything it returns is
/// base-currency-denominated; collateral or debt above zero is a position.
const aavePoolAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

export type EligibilityStatus = "idle" | "checking" | "passed" | "failed" | "error";

/// Which signal cleared the check, for the passed copy.
export type EligibilityVia = "txns" | "defi";

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
 * It stays a signal, not a gate. The contract accepts any address and the
 * published criteria weigh referrals, so a fresh wallet can still register — the
 * button just lets someone confirm the signal instead of the page guessing at
 * mount.
 */
export function useEligibilityCheck(account: Address | undefined): Eligibility {
  const [status, setStatus] = useState<EligibilityStatus>("idle");
  const [via, setVia] = useState<EligibilityVia | null>(null);
  const [mainnetTxns, setMainnetTxns] = useState<number | undefined>(undefined);
  const [sepoliaTxns, setSepoliaTxns] = useState<number | undefined>(undefined);
  const [defi, setDefi] = useState<boolean | undefined>(undefined);

  // A new wallet is a new question: clear a previous wallet's result so its
  // green tick cannot carry over to one nobody has checked.
  useEffect(() => {
    setStatus("idle");
    setVia(null);
    setMainnetTxns(undefined);
    setSepoliaTxns(undefined);
    setDefi(undefined);
  }, [account]);

  const run = useCallback(() => {
    if (!account) return;
    setStatus("checking");

    const txns = (chain: Chain): Promise<number | undefined> =>
      createPublicClient({ chain, transport: http() })
        .getTransactionCount({ address: account })
        .catch(() => undefined);

    const position = (): Promise<boolean | undefined> =>
      createPublicClient({ chain: ink, transport: http() })
        .readContract({
          address: INK_AAVE_POOL,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [account],
        })
        .then((d) => d[0] > 0n || d[1] > 0n)
        .catch(() => undefined);

    Promise.all([txns(ink), txns(inkSepolia), position()]).then(([m, s, pos]) => {
      setMainnetTxns(m);
      setSepoliaTxns(s);
      setDefi(pos);

      // Nothing answered *about the wallet* — every read down — is "could not
      // check", not "you failed".
      const answered = m !== undefined || s !== undefined || pos !== undefined;
      if (!answered) {
        setStatus("error");
        setVia(null);
        return;
      }

      const txnPass = (m ?? 0) >= MIN_INK_TXNS || (s ?? 0) >= MIN_INK_TXNS;
      // Order names the strongest real-usage signal first; passing is any-of.
      const winner: EligibilityVia | null = pos ? "defi" : txnPass ? "txns" : null;
      setVia(winner);
      setStatus(winner ? "passed" : "failed");
    });
  }, [account]);

  return { status, via, mainnetTxns, sepoliaTxns, defi, run };
}
