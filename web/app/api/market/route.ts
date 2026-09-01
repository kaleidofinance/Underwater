import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { launchpadAbi, memeTokenAbi } from "@/lib/abis";
import { CURVE, launchpadFor } from "@/lib/contracts";
import { marketCapWei, progressBps, spotPriceE18 } from "@/lib/curve";
import { indexedMarket, indexerServes } from "@/lib/indexer";
import {
  decodePool,
  isMarketSort,
  MARKET_LIMIT,
  priceSource,
  type Listing,
  type MarketSort,
  type MarketState,
  type PoolQuote,
} from "@/lib/market";
import { dexFor, pairsFor, quotesFor, settle } from "@/lib/server-dex";
import { newestTokens } from "@/lib/server-launchpad";
import { cached, cacheHeaders, chainFrom, serverClient } from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * The market, read once for everybody.
 *
 * This is the expensive one. `useListings` was 40 tokens × 4 reads plus a second
 * round for the graduated ones, re-run on every new block because lib/refresh.ts
 * invalidates contract reads when the head moves — a correct design that costs one
 * ~160-call `aggregate3` per tab per block. /swap and /profile ask for 100, so 400.
 * Multiply by a few hundred concurrent visitors and the numbers stop being
 * reasonable: it is the same answer, computed from scratch per tab, against an RPC
 * that rate-limits per IP.
 *
 * None of it is per-visitor. Reserves, names, prices, market caps and progress are
 * identical for everyone looking at the same chain in the same second, which makes
 * this exactly the shape lib/server-rpc.ts describes: read once behind a CDN, let
 * the edge serve the fan-out. The derivations run here too (lib/curve.ts is pure,
 * so it runs either side), which means the payload is final — the browser does no
 * arithmetic on it and cannot disagree with the next tab about a price.
 *
 * Still direct from the wallet's own RPC, deliberately: `balanceOf`, `allowance`,
 * `useBalance`, and every quote a trade is signed against. What is shared here is
 * what the page *shows*.
 *
 * **The shape of the read.** Each `await`-separated phase below is one RPC round
 * trip, and a round trip to a public endpoint is measured in seconds, not
 * milliseconds. The data dependency chain allows four of them: count + router →
 * token slice + factory/WETH → per-token fields + pair lookups → reserves. That is
 * the floor for this ABI, and it is why the two-phase pair dance is ordered the way
 * it is — `getPair` needs `weth` but not the pool decode, so it joins the per-token
 * round rather than waiting for it.
 *
 * **Unless there is an indexer**, in which case none of those round trips happen and
 * this is one `SELECT` — see `indexedMarket`. The RPC path stays because it is the only
 * one that works with nothing deployed but the contracts, and because it is what answers
 * while a backfill is still running. Four round trips against a rate-limited endpoint is
 * a fine fallback and a poor steady state; one query is the reverse.
 *
 * **`sort` and `offset` exist only on that path**, and the difference is structural
 * rather than a matter of effort. The chain gives a launch count and an index, so walking
 * it downwards from the head is the only order available without reading every launch
 * that ever happened — and ordering by market cap or volume means comparing figures that
 * have to exist first. So the route takes the request either way and reports what it
 * managed, on `MarketState.sort`, `.offset` and `.whole`. A page that asked for something
 * the chain cannot order is handed the newest launches and told so, which is what lets
 * the market page hide the control instead of offering one that does nothing.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/** Reads per token: pool, name, symbol, metadata URI. */
const PER_LISTING = 4;

/**
 * The memo, the edge window, and how long the edge may serve while it refreshes.
 *
 * Three seconds, where the head gets one. The head is a single `eth_blockNumber`
 * and worthless the moment it is stale; this is several hundred calls and four
 * round trips, and nothing on the page is improved by a market list that is 3s
 * fresher. `HeadSync` still invalidates the client query on every block, so a tab
 * asks this often — it is just answered at the edge most times, which is the whole
 * mechanism. Between the memo, the CDN window and the edge refreshes, the origin
 * pays for this read roughly once per window per region.
 *
 * The 30s `stale-while-revalidate` is doing real work: it means an RPC hiccup shows
 * as a market a few seconds behind rather than an empty page, and no visitor ever
 * waits on the round trips once the first one has landed.
 */
const MEMO_MS = 3_000;
const EDGE_S = 3;
const SWR_S = 30;

/**
 * How far into the market a request may ask to page.
 *
 * A bound rather than a policy: `offset` is the one thing a caller can put in this URL
 * that mints a new cache key, and the memo in lib/server-rpc.ts holds keys for the life
 * of the instance. Without a ceiling, `?offset=1e15` in a loop is unbounded growth in a
 * `Map` on every warm lambda. Ten thousand pages is far past any market this will see and
 * far short of a problem; past it the request is clamped and told where it landed.
 */
const MAX_OFFSET = MARKET_LIMIT * 10_000;

/**
 * The page a request is asking for, snapped to a `MARKET_LIMIT` boundary.
 *
 * Snapped rather than honoured exactly, and that is the whole reason paging is cheap
 * here: an arbitrary offset would give the cache a key per row the market page happens to
 * be scrolled to — 24 or 12 at a time, so several keys per hundred launches, times every
 * sort. Pages are hundreds, the browser walks each one in 24s, and only crossing an edge
 * is a read. The applied offset goes back on the payload so a caller that asked for
 * something else can see what it got.
 */
function pageAt(raw: string | null): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(Math.min(n, MAX_OFFSET) / MARKET_LIMIT) * MARKET_LIMIT;
}

async function readMarket(
  chain: Chain,
  launchpad: Address,
  sort: MarketSort,
  offset: number,
): Promise<MarketState> {
  // The indexer, if there is one serving this chain and it has finished its backfill.
  // Inside the memo rather than around it so both paths share one answer per window, and
  // ahead of the reads rather than beside them because a race would spend the RPC budget
  // this exists to save. Returns undefined on anything at all going wrong — including a
  // partial backfill, which would answer with a market that is quietly too small.
  const indexed = await indexedMarket(chain.id, launchpad, sort, offset);
  if (indexed) return indexed;

  const client = serverClient(chain);
  const common = { address: launchpad, abi: launchpadAbi } as const;

  // Round 1. The DEX promise is created first so its router read joins this same
  // tick — `batch: true` folds same-tick reads into one POST, and `newestTokens`
  // issues both of its own reads in that same tick.
  const dex = dexFor(client, chain.id, launchpad);
  const { tokenCount, tokens } = await newestTokens(client, launchpad);

  // Newest, first page, and saying so. Both are what walking the launchpad's index
  // counter downwards can offer: ordering by cap or volume needs every launch's figures
  // before it can compare any two of them, and reading them all is the four hundred
  // contract calls this route exists to avoid. The caller degrades on `whole` — the
  // market page drops the sorts that need the whole market rather than showing a control
  // that quietly does nothing. See `MarketState.whole`.
  const base = {
    chainId: chain.id,
    launchpad,
    tokenCount,
    sort: "new" as const,
    offset: 0,
    whole: false,
  };
  if (tokens.length === 0) return { ...base, listings: [] };

  // Round 2. The per-token fields and the pair lookups go in one tick: `getPair`
  // needs `weth` (round 1's DEX read, already settled) and nothing from the pool
  // decode, so waiting for the pools would only cost another round trip. The
  // zero-address results for pre-graduation tokens are dropped after.
  const { factory, weth } = await dex;
  const [rows, live] = await Promise.all([
    settle(
      tokens.flatMap((token) => [
        client.readContract({ ...common, functionName: "pools", args: [token] }),
        client.readContract({
          address: token,
          abi: memeTokenAbi,
          functionName: "name",
        }),
        client.readContract({
          address: token,
          abi: memeTokenAbi,
          functionName: "symbol",
        }),
        client.readContract({
          address: token,
          abi: memeTokenAbi,
          functionName: "metadataURI",
        }),
      ]),
    ),
    pairsFor(client, { factory, weth }, tokens),
  ]);

  // Round 3 — only in the rare case the DEX resolved and some token has a pair.
  // Spent on pricing here and not shipped: see the note on `MarketState`.
  const quotes: Record<string, PoolQuote> = await quotesFor(client, weth, live);

  const listings: Listing[] = [];
  tokens.forEach((token, i) => {
    const pool = decodePool(rows[i * PER_LISTING]);
    if (!pool || !pool.exists) return;
    const at = i * PER_LISTING;
    const name = rows[at + 1];
    const symbol = rows[at + 2];
    const uri = rows[at + 3];
    const { ethReserve, tokenReserve, fromPool } = priceSource(
      pool,
      quotes[token.toLowerCase()],
    );
    listings.push({
      token,
      // The same em-dash the rows used to fall back to locally, kept here so the
      // payload is what renders — a listing whose `name()` reverted still has a row.
      name: typeof name === "string" ? name : "—",
      symbol: typeof symbol === "string" ? symbol : "—",
      metadataURI: typeof uri === "string" ? uri : "",
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

  return { ...base, listings };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chain = chainFrom(url);
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  // Nothing to read. The client half never asks in this state — `useLaunchpad`
  // reports `configured: false` and the page renders `NotDeployed` — so this is
  // for a direct request, and 404 is the honest answer to "the market on a chain
  // we have not deployed to".
  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  // An unknown sort is the default rather than a 400: this is a browse control, and the
  // useful behaviour for a stale bookmark or a typo is the market rather than an error.
  const asked = url.searchParams.get("sort");
  const want = isMarketSort(asked) ? asked : "new";

  try {
    // Which answer can be produced decides the cache key, so it has to be settled before
    // the key rather than inside the read. Only the indexer can order or page the whole
    // market, so without it every request collapses onto the one key the RPC path can
    // fill — `market:1:new:0` — instead of each sort and page paying four hundred
    // contract calls for the same newest hundred launches. Costs nothing to ask: the
    // verdict is already cached and shared with the read below.
    const serves = await indexerServes(chain.id, launchpad);
    const sort: MarketSort = serves ? want : "new";
    const offset = serves ? pageAt(url.searchParams.get("offset")) : 0;

    const { value, stale } = await cached<MarketState>(
      `market:${chain.id}:${sort}:${offset}`,
      MEMO_MS,
      () => readMarket(chain, launchpad, sort, offset),
    );

    const body: Wire<MarketState> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // Only on a cold instance with no answer to fall back on — `cached` serves the
    // last known market through an outage. Logged because at this point the market
    // page is empty for everyone in this region and nothing else would say so.
    console.error(
      `[market] chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
