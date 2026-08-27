"use client";

import { useCallback, useMemo } from "react";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { launchpadAbi, memeTokenAbi } from "./abis";
import { CURVE, launchpadFor } from "./contracts";
import { marketCapWei, progressBps, spotPriceE18 } from "./curve";
import { usePoolQuote, usePoolQuotes, type PoolQuote } from "./dex";
import { useHydratedChainId } from "./hydration";

/** Decoded form of the launchpad's `pools(address)` getter. */
export type Pool = {
  ethReserve: bigint;
  tokenReserve: bigint;
  realEthRaised: bigint;
  tokensSold: bigint;
  creator: Address;
  createdAt: number;
  graduated: boolean;
  exists: boolean;
};

/**
 * Solidity flattens a struct-valued public mapping getter into positional
 * returns, so this arrives as an 8-tuple rather than an object.
 */
function decodePool(raw: unknown): Pool | null {
  if (!Array.isArray(raw) || raw.length < 8) return null;
  const t = raw as [
    bigint,
    bigint,
    bigint,
    bigint,
    Address,
    number,
    boolean,
    boolean,
  ];
  return {
    ethReserve: t[0],
    tokenReserve: t[1],
    realEthRaised: t[2],
    tokensSold: t[3],
    creator: t[4],
    createdAt: Number(t[5]),
    graduated: t[6],
    exists: t[7],
  };
}

export type Listing = {
  token: Address;
  name: string;
  symbol: string;
  /** Whatever the creator set. Resolved into art by lib/metadata.ts. */
  metadataURI: string;
  pool: Pool;
  priceE18: bigint;
  marketCap: bigint;
  progress: number;
  /** True once price is coming from the DEX pair rather than the closed curve. */
  fromPool: boolean;
};

/**
 * Which reserves a token is priced off.
 *
 * Before graduation that is the curve. After it, the curve's reserves are frozen
 * at their final values forever — the launchpad never writes them again — so a
 * graduated token has to be priced off its pair or the page would show a number
 * that no trade can move. The two differ by construction: the 5% graduation fee
 * comes out of the ETH before the pool is seeded, so a curve that closed at 25
 * gwei opens its pool nearer 19.
 *
 * Falls back to the frozen reserves while the pair reads are still in flight,
 * which keeps the layout stable instead of flashing a zero.
 */
function priceSource(pool: Pool, quote: PoolQuote | undefined) {
  if (pool.graduated && quote && quote.tokenReserve > 0n) {
    return {
      ethReserve: quote.ethReserve,
      tokenReserve: quote.tokenReserve,
      fromPool: true,
    };
  }
  return {
    ethReserve: pool.ethReserve,
    tokenReserve: pool.tokenReserve,
    fromPool: false,
  };
}

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

/** Reads per token in the listing multicall: pool, name, symbol, metadata URI. */
const PER_LISTING = 4;

/**
 * The market list, newest first.
 *
 * `tokensSlice` is newest-last, so we ask for the tail and reverse. Price, market
 * cap and progress are derived locally from the reserves (see lib/curve.ts) to
 * keep this at four reads per token instead of nine — plus a second batch for the
 * graduated ones, which are priced off their pair rather than the closed curve.
 */
export function useListings(limit = 40) {
  const { address, configured } = useLaunchpad();
  const { tokenCount } = useLaunchpadConfig();

  const start = tokenCount > BigInt(limit) ? tokenCount - BigInt(limit) : 0n;
  const count = tokenCount > BigInt(limit) ? BigInt(limit) : tokenCount;

  const { data: page, isLoading: loadingPage } = useReadContract({
    address: address ?? undefined,
    abi: launchpadAbi,
    functionName: "tokensSlice",
    args: [start, count],
    query: { enabled: configured && tokenCount > 0n, refetchInterval: 12_000 },
  });

  const tokens = useMemo(
    () => ((page as Address[] | undefined) ?? []).slice().reverse(),
    [page],
  );

  // Four reads a token, in one multicall. The fourth is the metadata URI: rows
  // show the token's art, and a list of forty identical grey squares was the
  // alternative.
  const { data: rows, isLoading: loadingRows } = useReadContracts({
    contracts: tokens.flatMap((token) => [
      {
        address: address ?? undefined,
        abi: launchpadAbi,
        functionName: "pools",
        args: [token],
      } as const,
      { address: token, abi: memeTokenAbi, functionName: "name" } as const,
      { address: token, abi: memeTokenAbi, functionName: "symbol" } as const,
      { address: token, abi: memeTokenAbi, functionName: "metadataURI" } as const,
    ]),
    query: { enabled: configured && tokens.length > 0, refetchInterval: 12_000 },
  });

  // Graduated tokens are priced off their pair, so they need a second round of
  // reads. Only they do — a live curve is fully described by the struct above.
  const graduated = useMemo(
    () =>
      rows
        ? tokens.filter((_, i) => decodePool(rows[i * PER_LISTING]?.result)?.graduated)
        : [],
    [rows, tokens],
  );
  const { quotes } = usePoolQuotes(graduated);
  const pairs = useMemo(() => Object.values(quotes), [quotes]);

  const listings = useMemo<Listing[]>(() => {
    if (!rows) return [];
    const out: Listing[] = [];
    tokens.forEach((token, i) => {
      const pool = decodePool(rows[i * PER_LISTING]?.result);
      const name = rows[i * PER_LISTING + 1]?.result as string | undefined;
      const symbol = rows[i * PER_LISTING + 2]?.result as string | undefined;
      const uri = rows[i * PER_LISTING + 3]?.result as string | undefined;
      if (!pool || !pool.exists) return;
      const { ethReserve, tokenReserve, fromPool } = priceSource(
        pool,
        quotes[token.toLowerCase()],
      );
      out.push({
        token,
        name: name ?? "—",
        symbol: symbol ?? "—",
        metadataURI: uri ?? "",
        pool,
        priceE18: spotPriceE18(ethReserve, tokenReserve),
        marketCap: marketCapWei(ethReserve, tokenReserve, CURVE.totalSupply),
        progress: progressBps(
          pool.realEthRaised,
          CURVE.graduationEth,
          pool.graduated,
        ),
        fromPool,
      });
    });
    return out;
  }, [quotes, rows, tokens]);

  return {
    listings,
    /**
     * The pairs behind the graduated listings. Handed out because the volume
     * scan has to read their `Swap` logs, and resolving them a second time would
     * mean repeating the factory lookups this hook has already paid for.
     */
    pairs,
    isLoading: loadingPage || loadingRows,
    isEmpty: tokenCount === 0n,
  };
}

/** Everything one token page needs, in a single batch. */
export function useTokenDetail(token: Address | undefined, holder?: Address) {
  const { address, configured } = useLaunchpad();
  const enabled = configured && !!token;

  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      {
        address: address ?? undefined,
        abi: launchpadAbi,
        functionName: "pools",
        args: token ? [token] : undefined,
      } as const,
      { address: token, abi: memeTokenAbi, functionName: "name" } as const,
      { address: token, abi: memeTokenAbi, functionName: "symbol" } as const,
      {
        address: token,
        abi: memeTokenAbi,
        functionName: "metadataURI",
      } as const,
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
      {
        address: token,
        abi: memeTokenAbi,
        functionName: "totalSupply",
      } as const,
    ],
    query: { enabled, refetchInterval: 8_000 },
  });

  const pool = decodePool(data?.[0]?.result);
  const { quote: pair, refetch: refetchPair } = usePoolQuote(
    token,
    !!pool?.graduated,
  );
  const { ethReserve, tokenReserve, fromPool } = pool
    ? priceSource(pool, pair)
    : { ethReserve: 0n, tokenReserve: 0n, fromPool: false };

  const refetchAll = useCallback(() => {
    refetch();
    refetchPair();
  }, [refetch, refetchPair]);

  return {
    pool,
    /** The DEX pair, once the curve has graduated into one. */
    pair,
    name: (data?.[1]?.result as string | undefined) ?? "",
    symbol: (data?.[2]?.result as string | undefined) ?? "",
    metadataURI: (data?.[3]?.result as string | undefined) ?? "",
    balance: (data?.[4]?.result as bigint | undefined) ?? 0n,
    allowance: (data?.[5]?.result as bigint | undefined) ?? 0n,
    totalSupply: (data?.[6]?.result as bigint | undefined) ?? CURVE.totalSupply,
    priceE18: spotPriceE18(ethReserve, tokenReserve),
    marketCap: marketCapWei(ethReserve, tokenReserve, CURVE.totalSupply),
    fromPool,
    progress: pool
      ? progressBps(pool.realEthRaised, CURVE.graduationEth, pool.graduated)
      : 0,
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
