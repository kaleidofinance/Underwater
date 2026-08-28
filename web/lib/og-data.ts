import { createPublicClient, getAddress, http, isAddress, type Address } from "viem";
import { factoryAbi, launchpadAbi, memeTokenAbi, pairAbi, routerAbi } from "./abis";
import { anvil, CHAINS, MULTICALL3 } from "./chains";
import { CURVE, launchpadFor } from "./contracts";
import { marketCapWei, progressBps, spotPriceE18 } from "./curve";
import { looksLikeImage, resolveUriAll } from "./uri";

/**
 * Everything a token's share card needs, read straight from the chain.
 *
 * The token page is `"use client"` and gets all of this from wagmi hooks, which
 * a share card cannot use: an OG route runs on the server, for a crawler with no
 * wallet, no connected chain and no React. So this is the same set of reads over
 * a plain viem client — and the same derivations, imported from lib/curve.ts
 * rather than restated, so a card can never disagree with the page it links to
 * about what a token is worth.
 *
 * Which chain. The page takes it from the wallet; a crawler fetching
 * `/token/0x…` supplies nothing, and `opengraph-image` is handed `params` but
 * never `searchParams`, so `?chain=` is not available here even when a human put
 * it in the link they shared. So the address is looked for on every chain that
 * has a launchpad configured, in the order lib/chains.ts declares them —
 * mainnet first, which is the same order the app defaults to. A token address is
 * effectively unique across chains, so the first hit is the right one.
 *
 * Every budget below is a crawler budget. X gives a card a few seconds before it
 * gives up and shows a bare link, so no read here waits longer than it would
 * take to be useless, and each one degrades to something printable rather than
 * throwing: a missing pair falls back to the curve's frozen reserves, missing art
 * falls back to the generated mark, and a chain that does not answer is simply
 * not the chain this token is on.
 */

/** One RPC round trip. Ink's public gel RPC answers a warm one in ~350ms. */
const RPC_TIMEOUT = 4_000;
/** The whole pair lookup, which is two dependent round trips deep. */
const PAIR_BUDGET = 5_000;
/**
 * Fetching the creator's art — the whole operation, not one request.
 *
 * A budget rather than a per-request timeout because an `ipfs://` URI naming a
 * metadata document costs two fetches, and two 4s timeouts in series is longer
 * than any crawler will wait for the entire card. Set below the pair lookup on
 * purpose: art is the one thing on the card that has a good fallback, so it is
 * the first thing that should be given up on.
 */
const ART_BUDGET = 2_500;
/** Art larger than this is not worth a card. Roughly a big PNG. */
const MAX_ART_BYTES = 2_500_000;
/** A metadata document, same ceiling as the client hook uses. */
const MAX_JSON = 256_000;

/**
 * Multicall3, patched onto whichever chain a card is being read from.
 *
 * The address now lives on the two Ink chains themselves — see the note on
 * `MULTICALL3` in lib/chains.ts, which explains what the caution this comment
 * used to carry ended up costing. The patch stays because `CHAINS` also holds
 * anvil, which deliberately does not declare it: recent foundry predeploys one at
 * the canonical address, so a dev-only card can use it, and a chain definition
 * every wagmi hook in the app reads through cannot bet on that.
 */
const withMulticall = (chain: (typeof CHAINS)[number]) => ({
  ...chain,
  contracts: { ...chain.contracts, multicall3: { address: MULTICALL3 } },
});

export type TokenCard = {
  token: Address;
  chainId: number;
  chainName: string;
  name: string;
  symbol: string;
  graduated: boolean;
  /** Wei per whole token, ×1e18 — the same scale `fmtPriceGwei` expects. */
  priceE18: bigint;
  marketCap: bigint;
  /** Basis points toward graduation, 0..10000. */
  progress: number;
  realEthRaised: bigint;
  createdAt: number;
  /** True once the price is coming from the pair rather than the closed curve. */
  fromPool: boolean;
  /** A data URI for the creator's art, or null if there is none to be had. */
  art: string | null;
};

/**
 * A client that batches.
 *
 * `batch: { multicall: true }` makes viem coalesce every `readContract` issued in
 * the same tick into one `aggregate3` — so each `Promise.all` below costs one
 * round trip instead of one per read. That is the single biggest thing that makes
 * these cards fast enough to be worth having: the opening read went from five
 * round trips to one, and on a public RPC answering in ~350ms that is most of the
 * latency budget back.
 *
 * Failures stay isolated: viem asks multicall3 to allow them and rejects only the
 * individual promise, so a token that is not on this chain still shows up as one
 * rejected read rather than poisoning the batch.
 */
function clientFor(chain: (typeof CHAINS)[number]) {
  return createPublicClient({
    chain: withMulticall(chain),
    batch: { multicall: true },
    transport: http(chain.rpcUrls.default.http[0], {
      timeout: RPC_TIMEOUT,
      // One retry, which is a change of mind that batching paid for.
      //
      // It used to be zero on the reasoning that a retry inside a crawler's
      // budget just spends the budget. That was right when the opening read was
      // five separate requests; now it is one, and Ink's public RPCs do drop
      // requests — measured, not feared: one in a handful of calls comes back
      // "RPC Request failed" and succeeds immediately on a second ask.
      //
      // With `Promise.all` over a single batched request, one drop loses the
      // whole card and `cardCache(MISS)` then remembers that for a minute. Paying
      // ~500ms to not show the wrong card is the better half of that trade.
      //
      // `[0]` rather than a `fallback` over the whole list, unlike the browser's
      // transport: a second endpoint would double the worst case, and a crawler
      // that has already waited RPC_TIMEOUT is gone. `[0]` is the healthier of
      // the two by the ordering in lib/chains.ts, which is the point of that
      // ordering.
      retryCount: 1,
      retryDelay: 150,
    }),
  });
}

/**
 * The chains worth asking, in declaration order.
 *
 * Anvil is dropped outside development because it is `127.0.0.1`: on a
 * deployed function that is the function itself, and the connection either hangs
 * for the full timeout or is refused. Neither is a useful thing to spend a
 * crawler's patience on.
 */
function candidates() {
  return CHAINS.filter(
    (chain) =>
      launchpadFor(chain.id) !== null &&
      (chain.id !== anvil.id || process.env.NODE_ENV === "development"),
  );
}

export async function readTokenCard(raw: string): Promise<TokenCard | null> {
  if (!isAddress(raw)) return null;
  const token = getAddress(raw);

  for (const chain of candidates()) {
    const launchpad = launchpadFor(chain.id);
    if (!launchpad) continue;

    const found = await readOnChain(chain, launchpad, token);
    if (found) return found;
  }

  // Logged once, here, rather than per chain in the catch below — a token on
  // mainnet legitimately misses on every other configured chain, so a line per
  // miss is noise. A line per *card we could not build* is the actionable event,
  // because the visible symptom is the site poster where a specimen sheet should
  // be and there is otherwise nothing to tell you it happened.
  console.warn(`[og] no launch found for ${token} on any configured chain`);
  return null;
}

async function readOnChain(
  chain: (typeof CHAINS)[number],
  launchpad: Address,
  token: Address,
): Promise<TokenCard | null> {
  const client = clientFor(chain);

  let pool: readonly unknown[];
  let name: string;
  let symbol: string;
  let metadataURI: string;
  let totalSupply: bigint;
  let router: Address;
  try {
    // One round trip, batched through multicall3. `router` rides along because it
    // is a read on the launchpad like `pools` and depends on nothing — putting it
    // here rather than at the head of the pair lookup takes a whole dependent hop
    // off graduated tokens and costs non-graduated ones a few bytes.
    [pool, name, symbol, metadataURI, totalSupply, router] = await Promise.all([
      client.readContract({ address: launchpad, abi: launchpadAbi, functionName: "pools", args: [token] }),
      client.readContract({ address: token, abi: memeTokenAbi, functionName: "name" }),
      client.readContract({ address: token, abi: memeTokenAbi, functionName: "symbol" }),
      client.readContract({ address: token, abi: memeTokenAbi, functionName: "metadataURI" }),
      client.readContract({ address: token, abi: memeTokenAbi, functionName: "totalSupply" }),
      client.readContract({ address: launchpad, abi: launchpadAbi, functionName: "router" }),
    ]);
  } catch {
    // Not on this chain, or this chain is not answering. Either way, next — and
    // silently, because "this token is not on Ink Sepolia" is the expected answer
    // for most tokens on most chains. `readTokenCard` logs the case that matters.
    return null;
  }

  // Solidity flattens a struct-valued public mapping getter into positional
  // returns, exactly as decodePool in lib/hooks.ts documents.
  if (pool.length < 8) return null;
  const ethReserve = pool[0] as bigint;
  const tokenReserve = pool[1] as bigint;
  const realEthRaised = pool[2] as bigint;
  const createdAt = Number(pool[5]);
  const graduated = pool[6] as boolean;
  const exists = pool[7] as boolean;

  if (!exists) return null;

  // Past graduation the curve's reserves are frozen forever and pricing off them
  // states a number no trade can move — see `priceSource` in lib/hooks.ts. The
  // fallback is the same one that hook uses while its pair reads are in flight.
  //
  // Run alongside the art fetch rather than after it: they share no data, and on
  // a graduated token with IPFS art the two budgets in series are most of what a
  // crawler is willing to wait in total.
  const frozen = { ethReserve, tokenReserve, fromPool: false as const };
  const [priced, art] = await Promise.all([
    graduated
      ? pairReserves(client, router, token).then((p) => p ?? frozen)
      : Promise.resolve(frozen),
    fetchArt(metadataURI),
  ]);

  return {
    token,
    chainId: chain.id,
    chainName: chain.name,
    name,
    symbol,
    graduated,
    priceE18: spotPriceE18(priced.ethReserve, priced.tokenReserve),
    marketCap: marketCapWei(priced.ethReserve, priced.tokenReserve, totalSupply),
    progress: progressBps(realEthRaised, CURVE.graduationEth, graduated),
    realEthRaised,
    createdAt,
    fromPool: priced.fromPool,
    art,
  };
}

/**
 * A router's factory and WETH, remembered for the life of the process.
 *
 * Both are `immutable` in UniswapV2Router02, set once in its constructor, so this
 * cannot go stale — which is why the memo is keyed on the router address rather
 * than on the chain. The launchpad's `router` is *not* immutable (there is an
 * owner-only setter), so that one is re-read on every card and a new router
 * simply gets a new memo entry.
 */
const routerParts = new Map<Address, Promise<readonly [Address, Address]>>();

function factoryAndWeth(
  client: ReturnType<typeof clientFor>,
  router: Address,
): Promise<readonly [Address, Address]> {
  let parts = routerParts.get(router);
  if (!parts) {
    // Memoised on the promise, so concurrent cards in one lambda share the read.
    // Dropped again on failure, or a single flaky RPC response would be cached
    // as "this router has no factory" for as long as the process lives.
    parts = Promise.all([
      client.readContract({ address: router, abi: routerAbi, functionName: "factory" }),
      client.readContract({ address: router, abi: routerAbi, functionName: "WETH" }),
    ]).catch((err) => {
      routerParts.delete(router);
      throw err;
    }) as Promise<readonly [Address, Address]>;
    routerParts.set(router, parts);
  }
  return parts;
}

/**
 * A graduated token's pair reserves, oriented so ETH is ETH.
 *
 * Two dependent round trips warm — factory/WETH from the memo, then `getPair`,
 * then reserves and `token0` batched together — but it still carries its own
 * budget on top of the per-call timeout, and returns null on anything at all
 * going wrong. A card that prices a graduated token off the curve is slightly
 * stale; a card that never renders is nothing.
 */
async function pairReserves(
  client: ReturnType<typeof clientFor>,
  router: Address,
  token: Address,
): Promise<{ ethReserve: bigint; tokenReserve: bigint; fromPool: true } | null> {
  const deadline = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), PAIR_BUDGET),
  );

  const work = (async () => {
    const [factory, weth] = await factoryAndWeth(client, router);
    const pair = await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getPair",
      args: [token, weth],
    });
    if (/^0x0+$/i.test(pair)) return null;

    const [reserves, token0] = await Promise.all([
      client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves" }),
      client.readContract({ address: pair, abi: pairAbi, functionName: "token0" }),
    ]);
    const wethIsToken0 = token0.toLowerCase() === weth.toLowerCase();
    const ethReserve = wethIsToken0 ? reserves[0] : reserves[1];
    const tokenReserve = wethIsToken0 ? reserves[1] : reserves[0];
    if (tokenReserve === 0n) return null;
    return { ethReserve, tokenReserve, fromPool: true as const };
  })().catch(() => null);

  return Promise.race([work, deadline]);
}

/**
 * The creator's art as a data URI, or null.
 *
 * Fetched here rather than handed to Satori as a remote `src` on purpose. Satori
 * will fetch a URL itself, but with no timeout and no size limit — so one slow
 * IPFS gateway becomes a card that never renders, and one 40MB PNG becomes a
 * function that runs out of memory. The URI comes from whoever launched the
 * token, so it gets the same treatment as everywhere else: only schemes
 * lib/uri.ts will follow, a hard byte ceiling, and a short clock.
 *
 * One clock for the whole thing, shared by every request. An `ipfs://` URI can
 * name a metadata document that names the image, which is two hops; giving each
 * its own timeout means the worst case is twice what was budgeted, and the worst
 * case is exactly what a bad gateway hands you.
 *
 * Each hop is raced across gateways rather than asked of one. That is what makes
 * the budget above achievable at all: the app's default gateway needs ~8s for
 * these two hops and the whole card is not worth that, so before the race every
 * token with real art silently rendered the generated mark instead. See
 * RACE_GATEWAYS in lib/uri.ts for the measurements.
 */
async function fetchArt(metadataURI: string): Promise<string | null> {
  const urls = resolveUriAll(metadataURI ?? "");
  if (!urls.length) return null;

  // A `data:` URI is one element and is already the thing — no request needed.
  if (urls[0].startsWith("data:image/")) {
    return urls[0].length <= MAX_ART_BYTES ? urls[0] : null;
  }
  if (urls[0].startsWith("data:")) return null;

  const signal = AbortSignal.timeout(ART_BUDGET);

  try {
    const art = looksLikeImage(urls[0]) ? urls : await imageFromDocument(urls, signal);
    if (!art?.length) return null;

    // The document hop can hand back the bytes themselves — see below.
    if (art[0].startsWith("data:image/")) {
      return art[0].length <= MAX_ART_BYTES ? art[0] : null;
    }

    const won = await race(art, signal, "image/*", (type) => type.startsWith("image/"));
    if (!won) return null;

    return `data:${won.type};base64,${won.bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** A gateway's answer, already read, so the losers of a race can be dropped. */
type Fetched = { type: string; bytes: Buffer };

/**
 * The first of several URLs to answer usably, or null if none of them does.
 *
 * `Promise.any` over attempts that *throw* when the answer is not usable, which
 * is what keeps a gateway's error page from beating a real image: a 504 or an
 * HTML "gateway timeout" rejects, and the race carries on to whoever else is
 * still working. Only the content-addressed IPFS case ever gets more than one
 * URL, so there is no question of two of them disagreeing.
 *
 * Every attempt reads its body to completion instead of the winner being read
 * afterwards. Slightly wasteful — the losers download bytes nobody wants — but
 * these are logos, and the alternative is aborting a shared signal at the moment
 * of victory, which races the winner's own body read.
 */
async function race(
  urls: string[],
  signal: AbortSignal,
  accept: string,
  usable: (type: string) => boolean,
): Promise<Fetched | null> {
  const attempts = urls.map(async (url) => {
    const res = await fetch(url, { signal, headers: { accept } });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);

    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!usable(type)) throw new Error(`${url}: ${type}`);

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_ART_BYTES) throw new Error(`${url}: ${declared} bytes`);

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ART_BYTES) throw new Error(`${url}: read ${bytes.length}`);

    return { type, bytes };
  });

  // Rejects with an AggregateError only when every gateway failed, and on an
  // empty list — both of which are the same "no art" answer.
  return Promise.any(attempts).catch(() => null);
}

/**
 * Follow a metadata document to the image it names, on the caller's clock.
 *
 * Returns candidate URLs for the image, or a one-element list holding the bytes
 * as a data URI when the document turned out to *be* the image — a URI with no
 * extension can be either, and having already read it there is no reason to ask
 * for it twice.
 */
async function imageFromDocument(urls: string[], signal: AbortSignal): Promise<string[] | null> {
  const won = await race(
    urls,
    signal,
    "application/json,image/*;q=0.8",
    // Anything but HTML. Gateways serve JSON as `text/plain` often enough that
    // insisting on `application/json` loses real documents, while an HTML body
    // is never one of these and is what a gateway sends when it has failed.
    (type) => type !== "text/html",
  );
  if (!won) return null;

  if (won.type.startsWith("image/")) {
    return [`data:${won.type};base64,${won.bytes.toString("base64")}`];
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(won.bytes.toString("utf8").slice(0, MAX_JSON)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (key: string) =>
    typeof json[key] === "string" ? (json[key] as string) : null;
  const image = pick("image") ?? pick("image_url") ?? pick("imageUrl");
  return image ? resolveUriAll(image) : null;
}
