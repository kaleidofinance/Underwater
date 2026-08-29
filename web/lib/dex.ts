"use client";

import { useMemo } from "react";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { factoryAbi, launchpadAbi, pairAbi, routerAbi } from "./abis";
import { launchpadFor } from "./contracts";
import { useHydratedChainId } from "./hydration";
import { present, type PoolQuote } from "./market";

/**
 * The DEX side of a token's life.
 *
 * Once a curve graduates the launchpad stops being the source of price: its
 * `ethReserve` / `tokenReserve` are frozen at their final values and never move
 * again, while the real price lives in the pair the launchpad seeded. Anything
 * that quotes a graduated token has to read the pair, so the resolution chain
 * lives here once instead of being inlined per component.
 *
 * Every address is resolved from `launchpad.router()` rather than from
 * configuration, so the frontend cannot end up pointed at a different DEX than
 * the one actually holding the liquidity.
 */

/**
 * Re-exported from lib/market.ts, where the shape moved so that `/api/market` can
 * build one without importing a `"use client"` module. Every existing importer
 * still reads it from here.
 */
export type { PoolQuote };

/**
 * Router, factory and WETH for the launchpad on the connected chain.
 *
 * All three are immutable for a given router, so they are cached for the
 * session. This resolves the launchpad address itself rather than calling
 * `useLaunchpad` — hooks.ts imports this module, and importing back would make
 * a cycle.
 */
export function useDex() {
  const chainId = useHydratedChainId();
  const launchpad = launchpadFor(chainId);

  const { data: routerResult } = useReadContract({
    address: launchpad ?? undefined,
    abi: launchpadAbi,
    functionName: "router",
    query: { enabled: !!launchpad, staleTime: Infinity },
  });
  const router = present(routerResult);

  const { data: cfg } = useReadContracts({
    contracts: [
      { address: router, abi: routerAbi, functionName: "factory" } as const,
      { address: router, abi: routerAbi, functionName: "WETH" } as const,
    ],
    query: { enabled: !!router, staleTime: Infinity },
  });

  return {
    router,
    factory: present(cfg?.[0]?.result),
    weth: present(cfg?.[1]?.result),
  };
}

/**
 * Live pair state for a set of tokens, in two batched rounds: pair addresses,
 * then reserves.
 *
 * Tokens with no pair are simply absent from the result, so passing a mix of
 * graduated and pre-graduation tokens is fine. Pass a memoised array — the
 * contract lists are rebuilt from it on every render.
 */
export function usePoolQuotes(tokens: readonly Address[]) {
  const { router, factory, weth } = useDex();

  const { data: pairData } = useReadContracts({
    contracts: tokens.map(
      (token) =>
        ({
          address: factory,
          abi: factoryAbi,
          functionName: "getPair",
          args: weth ? [token, weth] : undefined,
        }) as const,
    ),
    query: {
      // A pair address never changes once created, but a token that has not
      // graduated yet reads back as the zero address — so this is held briefly
      // rather than for the session, and a fresh graduation still lands.
      enabled: !!factory && !!weth && tokens.length > 0,
      staleTime: 30_000,
    },
  });

  const live = useMemo(
    () =>
      tokens
        .map((token, i) => ({ token, pair: present(pairData?.[i]?.result) }))
        .filter((row): row is { token: Address; pair: Address } => !!row.pair),
    [tokens, pairData],
  );

  const {
    data: state,
    isLoading,
    refetch,
  } = useReadContracts({
    contracts: live.flatMap(({ pair }) => [
      { address: pair, abi: pairAbi, functionName: "getReserves" } as const,
      { address: pair, abi: pairAbi, functionName: "token0" } as const,
    ]),
    query: { enabled: live.length > 0 && !!weth, refetchInterval: 8_000 },
  });

  const quotes = useMemo(() => {
    const out: Record<string, PoolQuote> = {};
    if (!state || !weth) return out;
    live.forEach(({ token, pair }, i) => {
      const reserves = state[i * 2]?.result as
        | readonly [bigint, bigint, number]
        | undefined;
      const token0 = present(state[i * 2 + 1]?.result);
      if (!reserves || !token0) return;
      const wethIsToken0 = token0.toLowerCase() === weth.toLowerCase();
      out[token.toLowerCase()] = {
        pair,
        wethIsToken0,
        ethReserve: wethIsToken0 ? reserves[0] : reserves[1],
        tokenReserve: wethIsToken0 ? reserves[1] : reserves[0],
      };
    });
    return out;
  }, [live, state, weth]);

  // "No pair" and "haven't looked yet" are different answers, and a caller that
  // renders an empty state has to tell them apart.
  const resolving =
    tokens.length > 0 && (!factory || !weth || (!pairData && !state));

  return { quotes, router, factory, weth, isLoading, refetch, resolving };
}

/** `usePoolQuotes` for a single token. Pass `enabled: false` to skip the reads. */
export function usePoolQuote(token: Address | undefined, enabled = true) {
  const tokens = useMemo(
    () => (token && enabled ? [token] : []),
    [token, enabled],
  );
  const { quotes, ...rest } = usePoolQuotes(tokens);
  return {
    quote: token ? quotes[token.toLowerCase()] : undefined,
    ...rest,
  };
}
