import type { Address } from "viem";
import { factoryAbi, launchpadAbi, pairAbi, routerAbi } from "./abis";
import { present, type PairSide, type PoolQuote } from "./market";
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
 * How long the fee switch's setting is believed for.
 *
 * A minute, matching what `useProtocolFeeTo` holds it in the browser. It is the
 * owner's to change at any time and it decides whether a whole leg of the protocol's
 * revenue exists, so it does not get the DEX's ten minutes — but it also changes
 * roughly never, and re-reading it on every visitor's read would buy nothing.
 */
const FEE_TO_MEMO_MS = 60_000;

/**
 * The factory's protocol-fee recipient, or nothing when the fee switch is off.
 *
 * Only ever a gate. `UnderwaterPair._mintFee` accrues the protocol a sixth of each
 * pool's 0.3% *only* while `feeTo` is set; with it unset the pools keep the whole fee
 * for their LPs and the protocol earns nothing on a swap. So a total that assumed it
 * on would be claiming revenue nobody is taking.
 *
 * Throws rather than resolving to "off" when the read fails, unlike {@link dexFor}
 * above it. The two are not the same kind of unknown: not knowing where the DEX is
 * degrades a price to the curve's frozen reserves, which is nearly right, while not
 * knowing whether the fee is on and guessing costs a leg of a revenue figure in one
 * direction or invents one in the other. A caller that would rather have the number
 * than the truth can catch it.
 */
export async function feeToFor(
  client: ServerClient,
  chainId: number,
  factory: Address | undefined,
): Promise<Address | undefined> {
  if (!factory) return undefined;
  const { value } = await cached<Address | undefined>(
    `fee-to:${chainId}`,
    FEE_TO_MEMO_MS,
    async () =>
      present(
        await client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "feeTo",
        }),
      ),
  );
  return value;
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
 */export async function quotesFor(
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

/**
 * Every pair the factory has ever made.
 *
 * The whole list rather than a lookup, because the callers that need this are scanning
 * `Swap` logs across all of them at once — one `eth_getLogs` with an address array is
 * what keeps a pool scan one request per range rather than one per pair per range.
 *
 * `allSettled`, so one index the endpoint drops costs that pair and not the scan. Empty
 * on any failure, which degrades a reader to curve-only rather than to nothing.
 */
export async function allPairs(
  client: ServerClient,
  factory: Address,
): Promise<Address[]> {
  try {
    const n = (await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "allPairsLength",
    })) as bigint;

    const found = await settle(
      Array.from({ length: Number(n) }, (_, i) =>
        client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "allPairs",
          args: [BigInt(i)],
        }),
      ),
    );
    return found.map(present).filter((a): a is Address => !!a);
  } catch {
    return [];
  }
}

/**
 * Which token each pair is the market for, keyed by lowercased pair address.
 *
 * The reverse of `pairsFor`, and needed for the same reason `sideFor` exists: a `Swap`
 * log names neither of the tokens it moved, so a reader turning one into a row a person
 * can understand has to ask the pair. Both sides are read and the non-WETH one wins,
 * rather than assuming an order — the same decision `quotesFor` documents.
 *
 * Immutable once a pair exists, so callers are free to memoise this forever.
 */
export async function tokensOfPairs(
  client: ServerClient,
  weth: Address | undefined,
  pairs: readonly Address[],
): Promise<Map<string, Address>> {
  const out = new Map<string, Address>();
  if (!weth || pairs.length === 0) return out;
  const w = weth.toLowerCase();

  const sides = await settle(
    pairs.flatMap((pair) => [
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "token1" }),
    ]),
  );

  pairs.forEach((pair, i) => {
    const token0 = present(sides[i * 2]);
    const token1 = present(sides[i * 2 + 1]);
    const token = token0?.toLowerCase() === w ? token1 : token0;
    if (token && token.toLowerCase() !== w) out.set(pair.toLowerCase(), token);
  });
  return out;
}

/**
 * How long "this token has no pair yet" is believed for.
 *
 * Only the negative answer needs a window at all, and it wants a short one: this is
 * what decides how late a just-graduated token's first pool trades can be. Fifteen
 * seconds is inside the noise of the caches already in front of it — the trade route
 * memoises for ten and the CDN for ten more — so it costs nothing visible and removes
 * a `getPair` from the steady state of every read.
 */
const UNGRADUATED_MEMO_MS = 15_000;

/** Orientations already resolved, per running instance. Never invalidated. */
const sides = new Map<string, PairSide>();

/**
 * A token's pair address and WETH orientation, resolved once and then kept.
 *
 * For the callers that decode historical `Swap` logs rather than price anything. Those
 * two fields cannot change — see {@link PairSide} — so once found they are held for the
 * life of the process, and a steady-state read spends no round trips here at all.
 *
 * Why that is worth a function of its own: the trade scan used to `await pairsFor` and
 * then `await quotesFor`, which is two *sequential* round trips before a single log
 * request goes out, on every read, forever. Against Ink's public endpoint that was
 * measured at several seconds of a read's whole budget, spent re-learning a fact that
 * was already known. Contract reads are the cheap part of this route right up until
 * they are the part it is waiting on.
 *
 * Built on `quotesFor` rather than reading `token0` directly, even though the reserves
 * come back unused. The orientation decision lives in exactly one place, and a second
 * copy of it is how a decoder comes to read buys as sells — the reserves ride along in
 * the same batch and cost no extra round trip.
 */
export async function sideFor(
  client: ServerClient,
  chainId: number,
  dex: Dex,
  token: Address,
): Promise<PairSide | undefined> {
  const key = `${chainId}:${token.toLowerCase()}`;
  const held = sides.get(key);
  if (held) return held;

  const { value } = await cached<PairSide | undefined>(
    `pair-side:${key}`,
    UNGRADUATED_MEMO_MS,
    async () => {
      const live = await pairsFor(client, dex, [token]);
      const quote = (await quotesFor(client, dex.weth, live))[token.toLowerCase()];
      if (!quote) return undefined;
      const side: PairSide = {
        pair: quote.pair,
        wethIsToken0: quote.wethIsToken0,
      };
      sides.set(key, side);
      return side;
    },
  );
  return value;
}
