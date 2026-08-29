import type { Address } from "viem";
import { factoryAbi, launchpadAbi, pairAbi, routerAbi } from "./abis";
import { present, type PoolQuote } from "./market";
import { cached } from "./server-rpc";
import type { ServerClient } from "./server-rpc";

/**
 * Resolving the DEX and reading pairs, from a route handler.
 *
 * The same two-phase dance `usePoolQuotes` does in the browser — router → factory
 * and WETH, then `getPair`, then reserves — except that here it is done once for
 * every visitor rather than once per tab. Both `/api/market` and `/api/token` need
 * it, so it lives beside the client that performs it rather than being written
 * twice with a chance of the two disagreeing about which side WETH sorted onto.
 *
 * Every address still comes from `launchpad.router()` rather than configuration,
 * for the reason lib/dex.ts gives: the server cannot end up pointed at a different
 * DEX than the one actually holding the liquidity either.
 */

/**
 * Router → factory → WETH is immutable for a deployed launchpad, so it is resolved
 * once per process rather than once per read. Long, not infinite: a bad minute
 * during the very first read would otherwise cache "no DEX" for the life of the
 * instance, and with it every graduated token priced off its frozen curve.
 */
const DEX_MEMO_MS = 10 * 60_000;

/**
 * `Promise.allSettled` over reads issued in one tick.
 *
 * Two properties, both load-bearing. It matches `useReadContracts`' default
 * `allowFailure` — one token whose `symbol()` reverts must not blank the market —
 * and creating every promise synchronously is what lets viem's `batch.multicall`
 * fold them into `aggregate3` (see `serverClient`). A sequential loop would be
 * correct and would also be four hundred round trips.
 *
 * `unknown` in and out because the rounds are heterogeneous: a round is a `pools`
 * tuple next to three strings next to a pair address. Narrowing happens per field
 * at the call site, where the shape is actually known.
 */
export async function settle(reads: Promise<unknown>[]): Promise<unknown[]> {
  const out = await Promise.allSettled(reads);
  return out.map((r) => (r.status === "fulfilled" ? r.value : undefined));
}

export type Dex = { factory?: Address; weth?: Address };

/**
 * Whatever the launchpad's own router says the DEX is, or nothing.
 *
 * Call this *before* the first await of a read so its `router()` lookup joins that
 * round trip instead of costing one of its own. On a memo hit it resolves without
 * issuing anything at all.
 *
 * An error resolves to `{}` rather than throwing: pricing then falls back to the
 * curve's frozen reserves, which is exactly what `priceSource` already does while
 * the browser's pair reads are in flight. A market a little wrong about a graduated
 * token beats no market.
 */
export function dexFor(
  client: ServerClient,
  chainId: number,
  launchpad: Address,
): Promise<Dex> {
  return cached<Dex>(`dex:${chainId}`, DEX_MEMO_MS, async () => {
    const router = present(
      await client.readContract({
        address: launchpad,
        abi: launchpadAbi,
        functionName: "router",
      }),
    );
    if (!router) return {};
    const [factory, weth] = await settle([
      client.readContract({
        address: router,
        abi: routerAbi,
        functionName: "factory",
      }),
      client.readContract({ address: router, abi: routerAbi, functionName: "WETH" }),
    ]);
    return { factory: present(factory), weth: present(weth) };
  })
    .then(({ value }) => value)
    .catch(() => ({}));
}

/**
 * `getPair` for a set of tokens, dropping the ones that have none.
 *
 * A token that has not graduated reads back as the zero address, so passing a mix
 * is fine — which is what lets this go in the same round as the per-token fields
 * rather than waiting for the pool decode to say which tokens are graduated.
 */
export async function pairsFor(
  client: ServerClient,
  dex: Dex,
  tokens: readonly Address[],
): Promise<{ token: Address; pair: Address }[]> {
  const { factory, weth } = dex;
  if (!factory || !weth || tokens.length === 0) return [];

  const found = await settle(
    tokens.map((token) =>
      client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "getPair",
        args: [token, weth],
      }),
    ),
  );
  return tokens
    .map((token, i) => ({ token, pair: present(found[i]) }))
    .filter((row): row is { token: Address; pair: Address } => !!row.pair);
}

/**
 * Reserves for resolved pairs, oriented ETH-side-first and keyed by lowercased
 * token address.
 *
 * `token0` is read alongside because which leg is ETH depends on how the two
 * addresses happened to sort when the pair was created — the same reason
 * `PoolQuote` carries `wethIsToken0` rather than assuming.
 */
export async function quotesFor(
  client: ServerClient,
  weth: Address | undefined,
  live: readonly { token: Address; pair: Address }[],
): Promise<Record<string, PoolQuote>> {
  const out: Record<string, PoolQuote> = {};
  if (!weth || live.length === 0) return out;

  const state = await settle(
    live.flatMap(({ pair }) => [
      client.readContract({
        address: pair,
        abi: pairAbi,
        functionName: "getReserves",
      }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    ]),
  );

  live.forEach(({ token, pair }, i) => {
    const reserves = state[i * 2] as readonly [bigint, bigint, number] | undefined;
    const token0 = present(state[i * 2 + 1]);
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
}
