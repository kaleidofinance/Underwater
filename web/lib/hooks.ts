"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { launchpadAbi, memeTokenAbi } from "./abis";
import { CURVE, launchpadFor } from "./contracts";
import { useHydratedChainId } from "./hydration";
import {
  decodeMarket,
  decodeToken,
  type Listing,
  type Pool,
} from "./market";
import { getJson } from "./wire";

/**
 * Re-exported from lib/market.ts, where the shapes and their decoders moved so
 * `/api/market` can build a listing without importing this `"use client"` module.
 * Every existing importer still reads them from here.
 */
export type { Listing, Pool };

export function useLaunchpad() {
  const chainId = useHydratedChainId();
  const address = launchpadFor(chainId);
  return { address, chainId, configured: address !== null };
}

/** Launchpad-wide config: fees, how many tokens exist, and what they hold. */
export function useLaunchpadConfig() {
  const { address, configured } = useLaunchpad();
  const common = { address: address ?? undefined, abi: launchpadAbi } as const;

  const { data, refetch } = useReadContracts({
    contracts: [
      { ...common, functionName: "tokenCount" },
      { ...common, functionName: "tradeFeeBps" },
      { ...common, functionName: "creationFee" },
      { ...common, functionName: "graduationFeeBps" },
      { ...common, functionName: "totalCurveEth" },
    ],
    query: { enabled: configured, refetchInterval: 12_000 },
  });

  return {
    tokenCount: (data?.[0]?.result as bigint | undefined) ?? 0n,
    tradeFeeBps: (data?.[1]?.result as bigint | undefined) ?? 0n,
    creationFee: (data?.[2]?.result as bigint | undefined) ?? 0n,
    graduationFeeBps: (data?.[3]?.result as bigint | undefined) ?? 0n,
    /**
     * ETH the live curves are holding right now. The contract keeps this
     * counter itself — it is what bounds the owner's sweep — so this is the one
     * aggregate that needs no summing over listings and cannot drift from what
     * the launchpad will actually pay out.
     */
    totalCurveEth: (data?.[4]?.result as bigint | undefined) ?? 0n,
    refetch,
  };
}

/**
 * How often a tab asks our own route for the market, as a floor.
 *
 * The same 12s the contract reads used, and for the same reason it barely matters:
 * `HeadSync` invalidates `['market']` on every new block, so this is what happens
 * when the head is not moving. What changed is the cost of following it — an edge
 * hit against a 3s-cached document instead of a ~160-call `aggregate3` on the
 * visitor's own RPC.
 */
const MARKET_POLL = 12_000;

/**
 * The token page's floor, matching the batch it replaced. Same reasoning as
 * `MARKET_POLL`: `HeadSync` drives the liveness, this is what happens when the head
 * is not moving.
 */
const TOKEN_POLL = 8_000;

/**
 * The whole market for the connected chain, from `/api/market`.
 *
 * One query for every caller — the market page, /swap, /profile, the protocol tab —
 * so navigating between them reuses the same cache entry rather than starting a
 * fresh read. The route always returns the newest `MARKET_LIMIT`; each caller takes
 * the front of it.
 *
 * No fallback to reading the chain directly, for the reason `useHead` gives at
 * length in lib/refresh.ts: an origin having a bad minute would otherwise turn
 * every open tab into an RPC client at once, which is the stampede the route exists
 * to prevent. The route already serves its last good answer through an outage
 * (`cached` in lib/server-rpc.ts) and says so; past that the page reports an error
 * rather than inventing a market.
 */
function useMarket() {
  const { chainId, configured } = useLaunchpad();

  const { data, isLoading, error } = useQuery({
    // Under no prefix wagmi uses, and distinct from `['market-volume']` — keys
    // compare element by element, so the log scan is not swept up by this one.
    queryKey: ["market", chainId],
    queryFn: ({ signal }) =>
      getJson(`/api/market?chain=${chainId}`, decodeMarket, signal),
    enabled: configured,
    refetchInterval: MARKET_POLL,
  });

  return { market: data, isLoading, error };
}

/**
 * The market list, newest first.
 *
 * `limit` slices the shared window rather than narrowing the read — see
 * `MARKET_LIMIT`. Price, market cap and progress arrive already derived, so two
 * tabs on different pages cannot show the same token at different prices.
 */
export function useListings(limit = 40) {
  const { market, isLoading, error } = useMarket();

  const listings = useMemo<Listing[]>(
    () => market?.listings.slice(0, limit) ?? [],
    [market, limit],
  );

  return {
    listings,
    isLoading,
    error,
    // Undefined until the read lands, so this is false while loading rather than
    // true. The old shape defaulted `tokenCount` to `0n`, which meant the market
    // page flashed "No launches yet — be the first" at every visitor on the way in.
    isEmpty: market?.tokenCount === 0n,
  };
}

/**
 * Everything one token page needs, split along the line that decides what can be
 * shared.
 *
 * `/api/token` serves the token's own state — pool, name, symbol, URI, supply,
 * pair, price — because it is the same for everyone looking at the same address in
 * the same second. `balanceOf` and `allowance` stay a direct read from the wallet's
 * own RPC, because they are one wallet's answer and a shared cache would either
 * leak them between visitors or be useless. Two queries where there was one batch,
 * and the expensive half is now paid for once per chain rather than once per tab.
 *
 * Both halves are invalidated together by `HeadSync` and by `useChainRefresh()`
 * after a transaction of ours confirms. They do not land together, though: the
 * wallet's half is a direct read and answers now, the shared half answers from a
 * three-second document. So a trade of yours shows in your balance first and in the
 * price a moment later — see the note on the window in the route.
 */
export function useTokenDetail(token: Address | undefined, holder?: Address) {
  const { address, chainId, configured } = useLaunchpad();
  const enabled = configured && !!token;

  const {
    data: shared,
    refetch: refetchShared,
    isLoading,
  } = useQuery({
    // Lowercased so a link with a different checksum spelling is the same cache
    // entry — the route canonicalises too, for the same reason.
    queryKey: ["token", chainId, token?.toLowerCase()],
    queryFn: ({ signal }) =>
      getJson(`/api/token/${token}?chain=${chainId}`, decodeToken, signal),
    enabled,
    refetchInterval: TOKEN_POLL,
  });

  // The visitor's own position. Kept here rather than moved to the route on
  // purpose: an address-keyed read cannot be shared, and the trade forms need it
  // fresh at the moment of signing.
  const { data: mine, refetch: refetchMine } = useReadContracts({
    contracts: [
      {
        address: token,
        abi: memeTokenAbi,
        functionName: "balanceOf",
        args: holder ? [holder] : undefined,
      } as const,
      {
        address: token,
        abi: memeTokenAbi,
        functionName: "allowance",
        args: holder && address ? [holder, address] : undefined,
      } as const,
    ],
    query: { enabled: enabled && !!holder, refetchInterval: 8_000 },
  });

  const refetchAll = useCallback(() => {
    refetchShared();
    refetchMine();
  }, [refetchMine, refetchShared]);

  return {
    pool: shared?.pool ?? null,
    /** The DEX pair, once the curve has graduated into one. */
    pair: shared?.pair ?? undefined,
    name: shared?.name ?? "",
    symbol: shared?.symbol ?? "",
    metadataURI: shared?.metadataURI ?? "",
    balance: (mine?.[0]?.result as bigint | undefined) ?? 0n,
    allowance: (mine?.[1]?.result as bigint | undefined) ?? 0n,
    totalSupply: shared?.totalSupply ?? CURVE.totalSupply,
    priceE18: shared?.priceE18 ?? 0n,
    marketCap: shared?.marketCap ?? 0n,
    fromPool: shared?.fromPool ?? false,
    progress: shared?.progress ?? 0,
    isLoading,
    refetch: refetchAll,
  };
}

/**
 * Gas limit to send with the buy that graduates a token.
 *
 * The launchpad refuses to attempt the liquidity deposit unless
 * `GRADUATION_GAS_RESERVE` is still available, so `eth_estimateGas` can no
 * longer settle on the cheap "graduation failed" path — it is forced up to a
 * limit the deposit actually fits in. That fix lives in the contract; this is
 * headroom on top of it.
 *
 * Why bother: the estimate is the *minimum* limit that works, measured against
 * state that can move before the transaction lands. If someone opens the pair
 * in the meantime the deposit takes a different, pricier path and the buy
 * reverts. Half the reserve again is enough slack to absorb that, and an
 * unused gas limit is not billed — only gas consumed is.
 *
 * Derived from the on-chain constant rather than a literal so it cannot drift
 * out of step with the contract. Returns null until the read lands, which the
 * caller reads as "let the wallet estimate".
 */
export function useGraduationGas(): bigint | null {
  const { address, configured } = useLaunchpad();

  const { data } = useReadContract({
    address: address ?? undefined,
    abi: launchpadAbi,
    functionName: "GRADUATION_GAS_RESERVE",
    query: { enabled: configured, staleTime: Infinity },
  });

  const reserve = data as bigint | undefined;
  return reserve ? reserve + reserve / 2n : null;
}

/**
 * Authoritative quote from the contract. `quoteBuy` mirrors `buy` exactly,
 * including the pre-graduation size-down and refund, so what this returns is
 * what the transaction will do.
 */
export function useQuote(
  token: Address | undefined,
  side: "buy" | "sell",
  amount: bigint | null,
  enabled: boolean,
) {
  const { address, configured } = useLaunchpad();

  const { data, error } = useReadContract({
    address: address ?? undefined,
    abi: launchpadAbi,
    functionName: side === "buy" ? "quoteBuy" : "quoteSell",
    args: token && amount !== null ? [token, amount] : undefined,
    query: {
      enabled: configured && enabled && !!token && amount !== null && amount > 0n,
    },
  });

  if (!data) return { quote: null, error };

  if (side === "buy") {
    const [tokensOut, fee, refund] = data as [bigint, bigint, bigint];
    return { quote: { out: tokensOut, fee, refund }, error };
  }
  const [ethOut, fee] = data as [bigint, bigint];
  return { quote: { out: ethOut, fee, refund: 0n }, error };
}
