"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Address, Hex } from "viem";
import { useReadContracts } from "wagmi";
import { platesAbi } from "./abis";
import { networkFor } from "./chains";
import { PLATES } from "./contracts";
import { useHydratedChainId } from "./hydration";

/// The plates collection on a chain, or null where there is not one.
///
/// Separate from `launchpadFor` on purpose, and the registry in lib/chains.ts
/// keeps them separate: the two systems are independent deploys, so a chain can
/// have one without the other — which is exactly the state a testnet is in halfway
/// through a launch. On the Robinhood networks it is null permanently rather than
/// pending, because the art reads Aave V3 health factors and there is no Aave V3
/// there; the note on `NETWORKS` makes that argument in full.
export function platesFor(chainId: number | undefined): Address | null {
  return networkFor(chainId)?.deployments.plates ?? null;
}

/**
 * The collection's `constant`s.
 *
 * Defined in lib/contracts.ts beside `CURVE` and re-exported here, which is where
 * everything already imports it from. It cannot live in this file: the share card
 * is a server route and this module is `"use client"`, so a server import of
 * `PLATES` from here gets a client reference rather than the object — see the
 * comment on the definition.
 */
export { PLATES };

export function usePlates() {
  const chainId = useHydratedChainId();
  const address = platesFor(chainId);
  return { address, chainId, configured: address !== null };
}

/** Everything the mint page reads off the collection, in one multicall. */
export type PlatesState = {
  minted: bigint;
  price: bigint;
  wlPrice: bigint;
  maxPerTx: bigint;
  maxPerWallet: bigint;
  merkleRoot: Hex;
  wlMinted: bigint;
  publicOpen: boolean;
  isSealed: boolean;
  isRevealed: boolean;
  mintCloses: bigint;
  reserve: bigint;
  /// Zero until the owner has pointed the collection at one, in which case
  /// `tokenURI` reverts and there is no art to show yet.
  renderer: Address;
  provenance: Hex;
  /// The connected wallet's plates, and what it has taken from the allowlist.
  owned: bigint;
  claimed: bigint;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * The mint's mutable state.
 *
 * Polled rather than read once: the prices and limits are settable, the phases
 * open while somebody is sitting on the page, and `minted` moves under everyone.
 * A page that read this at mount would quote a stale price into a contract that
 * demands exact payment, and the buyer would see a revert with no explanation.
 */
export function usePlatesState(account: Address | undefined) {
  const { address, configured } = usePlates();
  const common = { address: address ?? undefined, abi: platesAbi } as const;

  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      { ...common, functionName: "minted" },
      { ...common, functionName: "price" },
      { ...common, functionName: "wlPrice" },
      { ...common, functionName: "maxPerTx" },
      { ...common, functionName: "maxPerWallet" },
      { ...common, functionName: "merkleRoot" },
      { ...common, functionName: "wlMinted" },
      { ...common, functionName: "publicOpen" },
      { ...common, functionName: "isSealed" },
      { ...common, functionName: "isRevealed" },
      { ...common, functionName: "mintCloses" },
      { ...common, functionName: "reserve" },
      { ...common, functionName: "renderer" },
      { ...common, functionName: "provenance" },
      {
        ...common,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
      },
      {
        ...common,
        functionName: "wlClaimed",
        args: account ? [account] : undefined,
      },
    ],
    query: { enabled: configured, refetchInterval: 8_000 },
  });

  const state = useMemo<PlatesState>(() => {
    const at = <T,>(i: number, fallback: T): T =>
      (data?.[i]?.result as T | undefined) ?? fallback;
    return {
      minted: at(0, 0n),
      price: at(1, 0n),
      wlPrice: at(2, 0n),
      maxPerTx: at(3, 0n),
      maxPerWallet: at(4, 0n),
      merkleRoot: at<Hex>(5, ZERO_ROOT),
      wlMinted: at(6, 0n),
      publicOpen: at(7, false),
      isSealed: at(8, false),
      isRevealed: at(9, false),
      mintCloses: at(10, 0n),
      reserve: at(11, 0n),
      renderer: at<Address>(12, ZERO_ADDRESS),
      provenance: at<Hex>(13, ZERO_ROOT),
      owned: at(14, 0n),
      claimed: at(15, 0n),
    };
  }, [data]);

  return {
    state,
    /// True once the first batch has landed. Distinguished from "loading" because
    /// every field above has a zero fallback, and a page cannot tell a collection
    /// with nothing minted from one it has not read yet.
    ready: data?.[0]?.status === "success",
    isLoading,
    refetch,
  };
}

/**
 * Which of the mint's states the collection is in.
 *
 * The contract has no phase enum — it has a seal flag, a root, a latch and a
 * deadline, and the phase is whatever those four imply. Deriving it in one place
 * keeps the page from re-deriving it slightly differently in each panel, which is
 * how a heading ends up saying "live" over a disabled button.
 */
export type PhaseKind =
  | "unsealed"
  | "waiting"
  | "allowlist"
  | "public"
  | "soldout"
  | "over";

export type Phase = {
  kind: PhaseKind;
  /// `mintWhitelist` will accept a correct proof right now.
  wlOpen: boolean;
  /// `mint` is open to anybody.
  publicOpen: boolean;
  remaining: bigint;
  wlRemaining: bigint;
  /// Seconds until `mintCloses`, floored at zero. Zero also means "closed".
  closesIn: number;
};

export function phaseOf(state: PlatesState, now: number): Phase {
  const remaining = state.minted >= PLATES.supply ? 0n : PLATES.supply - state.minted;
  const wlRemaining =
    state.wlMinted >= PLATES.wlAllocation ? 0n : PLATES.wlAllocation - state.wlMinted;
  const closesIn = Math.max(0, Number(state.mintCloses) - now);

  // Deliberate order. Sold out outranks the deadline — a finished mint is
  // finished, and "closed" would read as though it ran out of time — and both
  // outrank the phase latches, which stay set forever afterwards.
  const kind: PhaseKind = !state.isSealed
    ? "unsealed"
    : remaining === 0n
      ? "soldout"
      : closesIn === 0
        ? "over"
        : state.publicOpen
          ? "public"
          : state.merkleRoot !== ZERO_ROOT
            ? "allowlist"
            : "waiting";

  const live = kind === "allowlist" || kind === "public";
  return {
    kind,
    wlOpen: live && state.merkleRoot !== ZERO_ROOT && wlRemaining > 0n,
    publicOpen: live && state.publicOpen,
    remaining,
    wlRemaining,
    closesIn,
  };
}

/**
 * The phase, with a clock behind it.
 *
 * The wall clock is deliberately not read during render: the server has one and
 * the browser has another, and a page whose first paint depends on the
 * difference hydrates into a mismatch. It starts at zero — which `phaseOf` reads
 * as a deadline far in the future, the same conclusion it draws from the
 * all-zeros state that is on screen at that moment anyway — and the effect
 * corrects it on the client.
 *
 * Ticks once a minute because `fmtDuration` shows minutes. A per-second clock
 * would re-render the whole page to change nothing.
 */
export function usePhase(state: PlatesState): Phase {
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  return useMemo(() => phaseOf(state, now), [now, state]);
}

/**
 * What the heading and the phase chip say, in one place.
 *
 * `phaseOf` decides which of the six states a collection is in; this only names
 * them, so a heading can never disagree with the button underneath it. Shared by
 * the showcase (`/plates`) and the checkout (`/mint`) so the two routes cannot
 * describe the same phase two different ways.
 */
export const PHASE_COPY: Record<
  PhaseKind,
  { badge: string; title: string; note: string }
> = {
  unsealed: {
    badge: "not open",
    title: "Nothing is for sale yet.",
    note: "The trait table has to be written on chain and checked against the provenance hash before minting can open. Until it is sealed, the contract refuses every mint.",
  },
  waiting: {
    badge: "soon",
    title: "Sealed, and waiting.",
    note: "The table is sealed and the collection is fixed. The allowlist opens when its root is published; the public phase follows it.",
  },
  allowlist: {
    badge: "allowlist",
    title: "The allowlist is open.",
    note: "2000 of the 2222 plates are held for the allowlist at the lower price. Whatever it does not use rolls into the public phase — no plate is stranded.",
  },
  public: {
    badge: "live",
    title: "Open to anyone.",
    note: "The public phase is open. Allowlist spots still mint at their own price for as long as the allocation lasts, because an allowlist spot is a right to that price and not a place in a queue.",
  },
  soldout: {
    badge: "sold out",
    title: "All 2222 are minted.",
    note: "Nothing left to mint. Which plate each number is gets decided at the reveal, and the secondary market is wherever you like.",
  },
  over: {
    badge: "closed",
    title: "The mint window has closed.",
    note: "Past the deadline the contract stops selling, and the reveal can be drawn on whatever was minted. Unminted plates stay unminted forever.",
  },
};

// ─── The allowlist ────────────────────────────────────────────────────────

/** `script/whitelist.py`'s output, as served. */
export type Allowlist = {
  root: Hex;
  members: number;
  proofs: Record<string, Hex[]>;
};

/**
 * The published proofs.
 *
 * `script/whitelist.py` writes this into `web/public/`, so it is a static asset
 * and a collection with no allowlist yet answers 404 rather than failing the
 * build — which is the state this repo is actually in. Proofs are public data:
 * they authorise nothing on their own, there are only as many as there are
 * members, and the root they hash to is already on chain for anyone to read.
 */
export function useAllowlist() {
  const { data, isLoading } = useQuery({
    queryKey: ["allowlist"],
    // Published as one static file, so it changes when the root does — and the
    // root is checked against the chain below. One fetch per session.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async (): Promise<Allowlist | null> => {
      const res = await fetch("/whitelist.json", {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      // A dev server answers a missing static path with an HTML 404 page, and
      // some hosts answer with the SPA shell and a 200, so the shape is checked
      // rather than the status.
      try {
        const json = (await res.json()) as Allowlist;
        return json && typeof json.root === "string" && json.proofs
          ? json
          : null;
      } catch {
        return null;
      }
    },
  });

  return { list: data ?? null, isLoading };
}

export type Membership = {
  /// The caller's sibling hashes, or null if this address is not on the list.
  proof: Hex[] | null;
  /// Whether a list was published at all.
  published: boolean;
  /// Whether the published list is the one the contract is verifying against.
  /// A mismatch is the failure the deploy notes warn about: `setMerkleRoot`
  /// succeeds silently against a root nobody has proofs for.
  rootMatches: boolean;
  members: number;
  isLoading: boolean;
};

export function useMembership(
  account: Address | undefined,
  root: Hex | undefined,
): Membership {
  const { list, isLoading } = useAllowlist();

  return useMemo(() => {
    const published = list !== null;
    const rootMatches =
      published && !!root && list.root.toLowerCase() === root.toLowerCase();
    // Keys are lowercased by whitelist.py, which discards checksum capitals
    // because a leaf hashes the 32 bytes and never the spelling.
    const proof =
      account && list ? (list.proofs[account.toLowerCase()] ?? null) : null;
    return {
      proof,
      published,
      rootMatches,
      members: list?.members ?? 0,
      isLoading,
    };
  }, [account, isLoading, list, root]);
}
