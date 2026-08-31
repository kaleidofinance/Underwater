import {
  createPublicClient,
  createTransport,
  fallback,
  http,
  numberToHex,
  type Chain,
  type EIP1193RequestFn,
  type Transport,
} from "viem";
import { anvil, CHAINS } from "./chains";

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
 * being quick. Same reasoning makes this a `fallback` over both endpoints rather
 * than `rpcUrls.default.http[0]` alone.
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
      chain.rpcUrls.default.http.map((url) =>
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
 * How many requests one refused chunk is allowed to become.
 *
 * A refusal is answered by halving, and halving is unbounded on its own: sixty
 * thousand blocks split down to one is sixteen levels and sixty-five thousand
 * requests, which is a far worse outage than the 502 it was trying to avoid. Sixteen
 * leaves is four levels, so a chunk can carry sixteen times the endpoint's cap before
 * the read honestly gives up — measured against a cap of ten thousand, that is a
 * hundred and sixty thousand of our own events inside one chunk, a volume regime that
 * wants a different design rather than more retries. The give-up is logged, because
 * "we stopped splitting" and "the chain has no logs" must not look the same.
 */
const SPLIT_LEAVES = 16;

/**
 * Wall clock one refused chunk's halving is allowed to take.
 *
 * Sixteen leaves bounds the *requests*, which is not the same as bounding the *time*:
 * measured on Ink Sepolia's gel endpoint, nine thousand unfiltered blocks did split
 * successfully into 125,854 logs — after 180 seconds. Every scan in this codebase sits
 * behind a deadline of 7s (/api/points) to 20s (/api/volume) and abandons a wave that
 * overruns it, so those 180 seconds were spent on an answer nobody was waiting for any
 * more, and — worse — kept issuing requests long after the route returned. An abandoned
 * split must stop splitting, not run to completion into nothing.
 *
 * Twenty seconds, the widest of those route budgets. A split that cannot finish inside
 * the longest deadline any caller has could not have been used by any of them, so
 * refusing it loses nothing and stops the runaway. The chain is not cancelled — the
 * request in flight is still owed an answer — it simply stops *descending*.
 */
const SPLIT_BUDGET_MS = 20_000;

/**
 * The refusals that mean "ask for less", as opposed to any other failure.
 *
 * Deliberately a text match, because there is nothing else to match on: the code is
 * `-32000`, the generic server error every client uses for everything. Three of these are
 * measured against the endpoints we actually use, and one endpoint needed two of them:
 * Robinhood Chain says `logs matched by query exceeds limit of 10000`, and Ink Sepolia's
 * gel endpoint says `query exceeds max results 20000, retry with the range …` and then,
 * intermittently, `backend response too large` for the halves that follow — a second
 * size limit behind the first, which the probe only found because the first was being
 * handled. The rest are the same limit as phrased by geth, Alchemy and Infura, included
 * so this keeps working if an endpoint is ever swapped.
 *
 * Kept narrow on purpose. A false positive costs at most {@link SPLIT_LEAVES}
 * requests on a chunk that was going to fail anyway, but it also turns one clear
 * error into sixteen confusing ones. In particular it must not match Ink's *range*
 * refusal (`block range greater than 10000 max`), which halving cannot fix and which
 * means the chunk width is wrong rather than the history dense.
 */
const LOG_LIMIT =
  /logs matched by query exceeds limit|query exceeds max results|retry with the range|response too large|log response size exceeded|more than \d+ results|too many logs/i;

/**
 * Whether an error is that refusal, anywhere in its causes.
 *
 * viem wraps a JSON-RPC error in several layers and puts the server's own words in
 * `details` rather than `message`, and `fallback` adds another layer on top when every
 * endpoint has failed — so the whole chain is walked rather than the top frame read.
 */
function isLogLimit(err: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    const o = e as Record<string, unknown>;
    for (const field of [o.message, o.details, o.shortMessage]) {
      if (typeof field === "string" && LOG_LIMIT.test(field)) return true;
    }
    queue.push(o.cause);
    if (Array.isArray(o.errors)) queue.push(...o.errors);
  }
  return false;
}

/** A block number the splitter can do arithmetic on, or null for a tag like `latest`. */
function blockNumber(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
  return null;
}

/**
 * `eth_getLogs`, halving the range and retrying whenever the endpoint refuses on
 * result count.
 *
 * Both chain families cap this call, and they cap different halves of it. Ink's
 * endpoints cap the *block range* — anything over ten thousand blocks is refused —
 * which is a property of the request, known before asking, so `logChunk` in
 * lib/chains.ts simply stays under it. Robinhood Chain has no range cap at all (a
 * five-million-block request is answered) and caps *matched logs* at ten thousand
 * instead, which is a property of the answer and cannot be known in advance. A chunk
 * width can be kept clear of the first kind; there is nothing to tune against the
 * second.
 *
 * And the second kind is not only Robinhood's, which is the measurement that turned this
 * from a Robinhood workaround into a general one. Ink Sepolia's two endpoints disagree
 * with each other: over the same nine thousand unfiltered blocks on 2026-08-31,
 * `rpc-qnd-sepolia` served 83,453 logs and `rpc-gel-sepolia` refused with `query exceeds
 * max results 20000`. `fallback` hides that — qnd is tried first and usually answers —
 * so the gel cap surfaces only when qnd is the endpoint having a bad minute, which is
 * exactly when a scan can least afford a permanent hole. Both phrasings are in
 * {@link LOG_LIMIT}.
 *
 * What splitting can and cannot fix, measured rather than assumed. Where the halves are
 * servable it is reliable: a 2,000-block Robinhood read of the chain's WETH goes from
 * refused to ~15,500 logs in under four seconds, on every attempt. Where the endpoint is
 * the bottleneck it is not — the same 2,000 unfiltered blocks on gel returned 27,864 logs
 * in 21.8s on one run and failed on the next with `backend response too large`, a *byte*
 * limit behind the result cap that appears to move with load. So splitting turns a
 * certain permanent failure into a likely success, not a guaranteed one, and the bounds
 * below exist so the unlikely case ends promptly and loudly instead of grinding. None of
 * this is on a path this app takes today — every scan here filters by address — but an
 * unfiltered one would meet it, so it is written down rather than discovered twice.
 *
 * Measured on 2026-08-31, and the measurement is what keeps this a rare path: the caps
 * count logs the filter *matched*, so our launchpad's entire history on Robinhood Testnet
 * — 382,680 blocks — is six logs in a single request, while the same range unfiltered is
 * refused. Every scan in this codebase filters by address, so a cap is reached only if
 * one of our own contracts emits more than ten thousand events inside one chunk. That is
 * a success, and this exists so that success is not also an outage: without it the chunk
 * fails on every read forever, and because `newestChunksUntil` treats anything except the
 * clock as a hole in the history, /api/volume and /api/trades 502 for that chain
 * permanently.
 *
 * Also measured: both endpoints *error*, `-32000` with those messages, and neither
 * truncates silently. That is the whole reason this can be a retry at all. A truncating
 * endpoint would hand back a short array with no indication, the caller would persist it
 * as a settled range, and the undercount would be permanent and invisible — nothing here
 * could detect it.
 *
 * The halves run in sequence, not together. `logClient` turns batching off and
 * {@link LANES} exists because this codebase has already watched a public endpoint drop
 * nineteen of forty concurrent calls; splitting in parallel would put up to sixteen
 * requests in flight per lane at the exact moment an endpoint is already complaining.
 * Sequential keeps it at one, and pays in latency — which is why there are two bounds
 * rather than one: {@link SPLIT_LEAVES} on how many requests a refusal may become, and
 * {@link SPLIT_BUDGET_MS} on how long it may spend becoming them. The first stops a
 * runaway fan-out, the second stops a chain still descending after the route that wanted
 * it has already given up on the clock in `newestChunksUntil`.
 */
function splitOnLogLimit(inner: Transport): Transport {
  return (opts) => {
    const transport = inner(opts);
    const request = transport.request as EIP1193RequestFn;

    const walk = async (
      args: { method: string; params: unknown[] },
      from: bigint,
      to: bigint,
      budget: { leaves: number; until: number },
    ): Promise<unknown[]> => {
      const filter = args.params[0] as Record<string, unknown>;
      const at = { ...filter, fromBlock: numberToHex(from), toBlock: numberToHex(to) };
      try {
        return (await request({ ...args, params: [at] } as never)) as unknown[];
      } catch (err) {
        if (!isLogLimit(err)) throw err;
        const spent = Date.now() > budget.until;
        if (from >= to || budget.leaves >= SPLIT_LEAVES || spent) {
          console.warn(
            `[rpc] eth_getLogs refused on size for blocks ${from}-${to} and will not split further (${budget.leaves}/${SPLIT_LEAVES} leaves, ${spent ? "out of" : "within"} the ${SPLIT_BUDGET_MS}ms budget) — failing the read rather than under-reporting it`,
          );
          throw err;
        }
        budget.leaves++;
        const mid = from + (to - from) / 2n;
        // Oldest first, so the concatenation stays in block order the way a single
        // unsplit response would have been.
        const older = await walk(args, from, mid, budget);
        const newer = await walk(args, mid + 1n, to, budget);
        return [...older, ...newer];
      }
    };

    return createTransport(
      {
        key: "splitLogs",
        name: "Log range splitter",
        type: "splitLogs",
        // The transport underneath already retries and fails over. Retrying here as
        // well would multiply both, which is the mistake LOG_TIMEOUT documents.
        retryCount: 0,
        timeout: opts.timeout,
        request: (async (args) => {
          const { method, params } = args as { method: string; params?: unknown[] };
          if (method !== "eth_getLogs" || !params?.length) return request(args as never);
          const filter = params[0] as Record<string, unknown> | undefined;
          const from = blockNumber(filter?.fromBlock);
          const to = blockNumber(filter?.toBlock);
          // A tag, or a `blockHash` filter: nothing to halve, so this is a plain
          // passthrough and a refusal stays a refusal.
          if (from === null || to === null) return request(args as never);
          return walk({ method, params }, from, to, {
            leaves: 1,
            until: Date.now() + SPLIT_BUDGET_MS,
          });
        }) as EIP1193RequestFn,
      },
      transport.value,
    );
  };
}

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
 * arrives sooner.
 *
 * {@link splitOnLogLimit} wraps the `fallback` rather than each endpoint inside it, so a
 * chunk that has to be halved is halved once and each half still gets both endpoints.
 * The other order would re-split against the second endpoint from scratch.
 */
export function logClient(chain: Chain) {
  return createPublicClient({
    chain,
    transport: splitOnLogLimit(
      fallback(
        chain.rpcUrls.default.http.map((url) =>
          http(url, { batch: false, timeout: LOG_TIMEOUT, retryCount: 1, retryDelay: 300 }),
        ),
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
