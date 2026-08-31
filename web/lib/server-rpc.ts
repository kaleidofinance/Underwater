import { createPublicClient, fallback, http, type Chain } from "viem";
import {
  anvil,
  CHAINS,
  envRpcUrls,
  ink,
  inkSepolia,
  publicEndpoints,
  robinhood,
  robinhoodTestnet,
} from "./chains";

/**
 * The server's side of a chain read, and the cache in front of it.
 *
 * Everything live in this app is currently read browser → RPC directly: one tab
 * polls the head every 2s, `HeadSync` invalidates every contract read on each new
 * block, and the market page's batch is 40 tokens × 4 reads. That is fine for one
 * visitor and it is the same work repeated per visitor, so at a few hundred
 * concurrent tabs it is a few hundred times the necessary load on an RPC that
 * rate-limits per IP — the failure this codebase has already met once, when the
 * gate rendered "closed" over an open window (see `MULTICALL3` in lib/chains.ts).
 *
 * The fix is not a bigger RPC plan, it is noticing that almost none of it is
 * per-visitor data. Reserves, prices, the listing page and the trade feed are
 * identical for everyone looking at the same chain in the same second. So they are
 * read *once* here, behind a CDN cache, and every tab reads the answer.
 *
 * Two caches, doing different jobs:
 *
 *  - **The CDN**, via `Cache-Control: s-maxage` on each route. This is what makes
 *    fan-out free: a thousand tabs asking within the window are served at the edge
 *    and the origin is not invoked at all.
 *  - **{@link cached}**, a module-scope memo inside the running instance. Covers
 *    what the CDN cannot: a cold edge, several Vercel regions each missing
 *    separately, and `stale-while-revalidate` refreshes. It also dedupes
 *    concurrent misses, which is exactly the moment a cache window rolls over
 *    under load.
 *
 * `/api/eth-usd` already had both halves for the same reason, against an exchange
 * rather than an RPC — this generalises what that route hand-rolled.
 *
 * What deliberately does *not* come through here: anything keyed to an address.
 * `balanceOf`, `allowance`, `useBalance` and the waitlist's `standingOf` are one
 * visitor's data, uncacheable by construction, and they stay direct reads from the
 * wallet's own RPC. And no transaction is ever built on a cached number — the
 * trade forms quote against the chain immediately before signing, so what is
 * shared here is what the page *shows*, never what it *sends*.
 */

/**
 * One RPC round trip from a route handler.
 *
 * Longer than lib/og-data.ts allows itself, and the difference is the point: a
 * share card is racing a crawler that will give up, so it takes the first endpoint
 * and a 4s ceiling. These routes sit behind a CDN, so one slow read is amortised
 * over every visitor in the cache window and being *right* is worth more than
 * being quick. Same reasoning makes this a `fallback` over every endpoint
 * {@link serverEndpoints} offers rather than the first one alone.
 */
const RPC_TIMEOUT = 6_000;

/**
 * The ceiling for one `eth_getLogs` — see {@link logClient}.
 *
 * Was twenty seconds, on the reasoning that a nine-thousand-block scan is not a
 * six-second request on a bad minute and the whole thing sits behind a cache window
 * anyway. That was wrong in a way only measurement showed: with the retry below, twenty
 * seconds is a minute of permitted waiting for a single chunk, and reads given a
 * seven-second budget were observed taking 41 and 45 seconds — one hung request
 * outlasting the request that contained it.
 *
 * The scans bound themselves by the clock now and abandon a wave that overruns
 * (`newestChunksUntil` in lib/chunks.ts), which changes what this number is for. It is
 * no longer "how long a slow answer may take to arrive" — an answer nobody is waiting
 * for any more is worth nothing — it is how long to hold a socket open on an endpoint
 * that is rate-limiting us before trying the other one. Eight seconds: an order of
 * magnitude above a healthy chunk, and below the point where waiting has stopped
 * being useful.
 */
const LOG_TIMEOUT = 8_000;

/**
 * The chain a request is asking about, or null if it names one we will not serve.
 *
 * Explicit rather than inferred: a route handler has no wallet and no connected
 * chain, so the client has to say. Unset means Ink Mainnet, which is `CHAINS[0]`
 * and the same default the app itself opens on.
 *
 * Anvil is refused outside development for the reason lib/og-data.ts gives about
 * its own candidate list: `127.0.0.1:8545` evaluated on a deployed function is the
 * function itself, and the read either hangs for the whole timeout or is refused.
 *
 * Validating against `CHAINS` rather than trusting the parameter is also what
 * stops `?chain=` being an open proxy — an unvalidated id would let anyone pick
 * the URL our server sends a POST to.
 */
export function chainFrom(url: URL): Chain | null {
  const raw = url.searchParams.get("chain");
  const chain = raw === null ? CHAINS[0] : CHAINS.find((c) => String(c.id) === raw);
  if (!chain) return null;
  if (chain.id === anvil.id && process.env.NODE_ENV !== "development") return null;
  return chain;
}

/**
 * The endpoints this server may use for a chain, in preference order.
 *
 * A private endpoint first, then whatever a browser would use — the public override
 * if one is set, then the registry's shared endpoints. Nothing is replaced, only
 * ranked: `fallback` walks the list on error, so an endpoint that is down, throttled
 * or out of credit costs a retry rather than the read, and the shared endpoints stay
 * as the last thing that still answers.
 *
 * The variables here carry no `NEXT_PUBLIC_` prefix, and that is the whole point of
 * this living in a server-only module rather than beside {@link publicEndpoints} in
 * lib/chains.ts. A provider URL is usually its own credential — the key is the path —
 * and a name without that prefix is never compiled into the bundle a visitor
 * downloads. So this is where a paid endpoint goes, and it is the right place for it
 * on the load as well as the secrecy: the reads behind these routes are made once per
 * cache window on behalf of every visitor, which is the traffic worth paying for.
 *
 * `<KEY>_RPC_URL`, the same names foundry's fork tests and `--rpc-url` aliases use,
 * so one word names the network across the repo — see {@link Network.key}. Written out
 * per network rather than looked up by key: nothing forces that here the way Next's
 * inlining does in the browser, but a `switch` is the form that fails loudly when a
 * network is added, where a template string would quietly return nothing.
 */
export function serverEndpoints(chain: Chain): readonly string[] {
  return [...privateOverride(chain.id), ...publicEndpoints(chain)];
}

function privateOverride(chainId: number): readonly string[] {
  switch (chainId) {
    case ink.id:
      return envRpcUrls(process.env.INK_RPC_URL);
    case inkSepolia.id:
      return envRpcUrls(process.env.INK_SEPOLIA_RPC_URL);
    case robinhood.id:
      return envRpcUrls(process.env.ROBINHOOD_RPC_URL);
    case robinhoodTestnet.id:
      return envRpcUrls(process.env.ROBINHOOD_TESTNET_RPC_URL);
    default:
      // Anvil, whose endpoint is the loopback address of the machine running it —
      // and which `chainFrom` refuses outside development anyway.
      return [];
  }
}

/**
 * A batching, failing-over client for one chain.
 *
 * `batch: { multicall: true }` folds every `readContract` issued in the same tick
 * into one `aggregate3` — the chains declare multicall3 themselves now, so this
 * needs no patching. Anvil declares none on purpose and simply issues one request
 * per read, which is free against a local node.
 *
 * `http(..., { batch: true })` on top of that, which the browser's client has had
 * all along and which matters more here. viem chunks a multicall by calldata size,
 * so `/api/market`'s several hundred reads become not one `aggregate3` but a
 * handful — deliberately, since a single call that large is the kind of thing an
 * RPC answers with a gas cap rather than an answer. JSON-RPC batching puts those
 * chunks in one POST, so the shape is many small calls in one round trip instead of
 * one enormous call or many round trips.
 *
 * Not memoised. A viem client is a thin object around the transport, the routes
 * make one per request, and the thing worth caching is the *answer* — see
 * {@link cached}.
 */
export function serverClient(chain: Chain) {
  return createPublicClient({
    chain,
    batch: { multicall: true },
    transport: fallback(
      serverEndpoints(chain).map((url) =>
        http(url, {
          batch: true,
          timeout: RPC_TIMEOUT,
          retryCount: 1,
          retryDelay: 200,
        }),
      ),
    ),
  });
}

export type ServerClient = ReturnType<typeof serverClient>;

/**
 * A client for chunked log scans, which want the opposite trade-offs.
 *
 * Three differences from {@link serverClient}, each for a measured reason. The timeout
 * is longer because an `eth_getLogs` over nine thousand blocks is not a six-second
 * request on a bad minute — but bounded, for the reason {@link LOG_TIMEOUT} explains at
 * length. JSON-RPC batching is *off*: with it, a wave of chunk requests issued in one
 * tick becomes a single POST, so one slow chunk holds up five others and a timeout loses
 * all six — separate requests fail and retry independently.
 *
 * And exactly one retry, where this used to take two. The reason for retrying at all
 * stands: the endpoint this codebase measured dropped nineteen of forty calls, and a
 * dropped chunk is a hole in the middle of a history rather than one stale number. But
 * each retry multiplies the timeout, and the second one was buying a third attempt at
 * the endpoint that had already failed twice while the `fallback` beside it has a
 * *different* endpoint to offer — which is the better answer to a dropped request, and
 * arrives sooner. That is also the argument for {@link serverEndpoints}: the scans are
 * the heaviest thing this server does, so they are the first beneficiary of an endpoint
 * that does not drop requests in the first place.
 */
export function logClient(chain: Chain) {
  return createPublicClient({
    chain,
    transport: fallback(
      serverEndpoints(chain).map((url) =>
        http(url, { batch: false, timeout: LOG_TIMEOUT, retryCount: 1, retryDelay: 300 }),
      ),
    ),
  });
}

export type LogScanClient = ReturnType<typeof logClient>;

type Entry = { value: unknown; at: number };

/** Answers, and the reads still in flight for them. Per running instance. */
const answers = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

/**
 * A read, memoised for `ttlMs`, deduped while in flight, and served stale rather
 * than not at all.
 *
 * The stale path is the half worth arguing for. When the RPC is having the kind of
 * minute Ink's public endpoints do have, the choice is a number from thirty
 * seconds ago or a blank market — and for reserves on a chain producing a block a
 * second, thirty seconds old is a perfectly ordinary thing to have been shown. The
 * caller is told (`stale: true`) so the response can say so.
 *
 * Rethrows only when there is nothing to fall back on, which on a cold instance is
 * the honest answer and the routes turn into a 502. Never caches the failure: a
 * bad minute must not become a bad cache window.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  read: () => Promise<T>,
): Promise<{ value: T; stale: boolean }> {
  const now = Date.now();
  const held = answers.get(key);
  if (held && now - held.at < ttlMs) {
    return { value: held.value as T, stale: false };
  }

  // One read per key at a time. Without this, a burst arriving the moment the
  // window rolls sends one RPC request each — the thundering herd this whole file
  // exists to prevent, reintroduced at the origin.
  let pending = inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = read();
    inFlight.set(key, pending);
    void pending.catch(() => {}).finally(() => inFlight.delete(key));
  }

  try {
    const value = await pending;
    answers.set(key, { value, at: Date.now() });
    return { value, stale: false };
  } catch (err) {
    if (held) return { value: held.value as T, stale: true };
    throw err;
  }
}

/**
 * The CDN instruction, which is where the actual scaling happens.
 *
 * `s-maxage` is how long the edge may serve a response without asking again;
 * `stale-while-revalidate` lets it keep serving after that while it refreshes in
 * the background, so no visitor ever waits on an RPC round trip once the first one
 * has landed.
 *
 * Worth being exact about the win, because it is large but not infinite: the edge
 * caches per region, so the origin sees roughly one read per window *per active
 * region* rather than one globally. Against one read per tab per window, that is
 * still the difference between hundreds of requests a second and single figures.
 */
export function cacheHeaders(sMaxAge: number, swr: number) {
  return {
    "Cache-Control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
  };
}
