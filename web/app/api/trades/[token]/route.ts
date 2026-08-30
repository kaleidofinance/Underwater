import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address, type Chain } from "viem";
import {
  deployBlock,
  lanes,
  newestChunksUntil,
  ranges,
  REORG_TAIL,
  type Range,
} from "@/lib/chunks";
import { launchpadFor } from "@/lib/contracts";
import { SWAP_EVENT, SYNC_EVENT, TRADE_EVENT } from "@/lib/events";
import type { PoolQuote } from "@/lib/market";
import {
  curveRow,
  newestFirst,
  poolRow,
  ROWS,
  STAMP_BUDGET,
  syncIndex,
  type FeedState,
  type Trade,
} from "@/lib/scans";
import { dexFor, pairsFor, quotesFor } from "@/lib/server-dex";
import {
  cached,
  cacheHeaders,
  chainFrom,
  logClient,
  serverClient,
  type LogScanClient,
} from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * One token's trades, scanned once for everybody and kept between reads.
 *
 * The dearest read in the app, and it used to be answered by whatever nine thousand
 * blocks the endpoint would serve — so a token launched yesterday looked as though it
 * had no history at all. Now the range is its whole life: from the block the
 * launchpad was deployed in up to the head, in chunks the endpoint will accept.
 *
 * Three things keep that affordable. Chunks are walked **newest first and stopped
 * early**, so a busy token is answered by the first request or two and only a quiet one
 * is followed further back. What has been found is kept — rows below the reorg tail
 * cannot change, so a steady-state read scans the tail and the sliver of new blocks
 * since the last one, not the history again. And no single read spends more than
 * {@link DEEPEN_MS} reaching backwards, so the first request for a quiet token is a few
 * seconds rather than one a serverless platform would kill.
 *
 * `complete` therefore means something it never did before: every trade this token
 * has ever made is in the payload. When it is false, the reason is this side of the
 * wire and not the endpoint's — either the {@link ROWS} cap stopped the walk, or the
 * backfill has not got all the way back yet and will have in a read or two.
 *
 * The pair is resolved here rather than accepted from the caller. `getPair` reads back
 * the zero address for a token still on its curve, so one cheap call answers "is there
 * a pool half to scan" without trusting a query parameter about it.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * Ten seconds at the edge, thirty of staleness allowed while it refreshes.
 *
 * **Your own trade waits for this window, and there is no way around that.**
 * `useChainRefresh()` invalidates `['trades']` when a transaction of ours confirms,
 * but a React Query invalidation only forces a new *request* — the CDN answers it
 * from the same document until the window rolls, so a row can be up to `EDGE_S`
 * (or `EDGE_S + SWR_S`, if the edge chooses to serve stale) behind. Which is why
 * these two numbers are as low as an expensive read can afford: the alternative is
 * a per-refresh cache key, and that is the same as having no shared cache at the
 * exact moment lots of people are trading.
 *
 * What does not wait: the balance, which is a direct read, and the price and
 * progress bar, which come from /api/token's three-second document. So the visible
 * order after a trade of yours is balance, then price, then the row — not nothing.
 */
const MEMO_MS = 10_000;
const EDGE_S = 10;
const SWR_S = 30;

/** Chunk requests in flight per wave. Each chunk is three log requests of its own. */
const WAVE = 3;

/**
 * Wall clock one read will spend reaching backwards, in milliseconds.
 *
 * The early exit means a busy token needs none of this: enough rows turn up in the
 * first wave or two and the older chunks are never touched. A token with fewer than
 * {@link ROWS} trades has no early exit to take, and following it all the way to the
 * launchpad's first block measured 13 seconds on a good minute and 44 on a bad one —
 * past the ceiling a serverless function gets on default settings, so that read would
 * be killed rather than merely slow and the token would look permanently broken.
 *
 * `export const maxDuration` is not the way out: on Next 15.5.23 it drags the Pages
 * Router shims through Turbopack and `next build` dies on a runtime chunk that is never
 * emitted — the same trap `revalidate` set (see /api/head). So the handler limits
 * itself, and it does so by the clock rather than by a chunk count, because the same
 * fifteen chunks were 4 seconds and 13 seconds on the two minutes above. A count bounds
 * the work; only a clock bounds the *request*, which is the thing with a ceiling over
 * it.
 *
 * Measured from the start of the handler, so the floor search and the pair resolution
 * are inside it. Seven seconds because the ceiling being aimed at is the ten-second
 * default a Node function gets on Vercel's cheapest plan. The clock is enforced per wave
 * rather than merely consulted between them: the first version of this consulted it
 * between waves and was blown through by single waves of 26 and 45 seconds, since a log
 * request left to its own timeout and retries can outlast the whole budget by itself. See
 * `newestChunksUntil` in lib/chunks.ts, and `LOG_TIMEOUT` in lib/server-rpc.ts for the
 * other half of it.
 *
 * There is always one wave, so every read makes progress even when the pre-work has
 * already spent the budget: on that endpoint a quiet token's whole history arrives over
 * a dozen reads, with `complete` false until it does. This is also the reason to bound
 * by the clock rather than by chunks — the same constant converges in two reads against
 * an endpoint that answers quickly, with no number to retune.
 */
const DEEPEN_MS = 7_000;

/* ---------------------------------------------------------------------------
 * What is kept between reads.
 * ------------------------------------------------------------------------- */

/**
 * A token's rows and the range they were found in, per running instance.
 *
 * `lo`/`hi` are the settled blocks already scanned. `pair` is remembered because a
 * token that graduates gains a second source of trades, and the range already scanned
 * was scanned without it — the honest response to that is to throw one token's rows
 * away and scan again, which costs a few requests, rather than to serve a history
 * missing every pool trade before the graduation was noticed.
 */
type Kept = {
  rows: Trade[];
  lo: bigint;
  hi: bigint;
  pair: string | null;
};

const FEEDS_MAX = 64;
const feeds = new Map<string, Kept>();

/**
 * Block timestamps and transaction senders, per running instance.
 *
 * Split into two maps rather than caching whole blocks, which is what the browser
 * did. A block on a busy chain carries far more transactions than any page will ask
 * about, and holding all of them for every block a scan touched is how a long-lived
 * server instance turns a bounded read into an unbounded one. So: every stamp (one
 * number), and only the senders some row actually came from.
 *
 * Blocks are immutable, so an entry is never wrong, only ever evicted — oldest
 * insertion first, which is also oldest block first in practice since scans walk
 * backwards from the head.
 */
const STAMP_MAX = 20_000;
const SENDER_MAX = 20_000;
const stamps = new Map<string, number>();
const senders = new Map<string, Address>();

function trim<V>(map: Map<string, V>, max: number) {
  if (map.size <= max) return;
  let drop = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--drop <= 0) break;
  }
}

/* ---------------------------------------------------------------------------
 * The scan.
 * ------------------------------------------------------------------------- */

/**
 * Every row in one range, both venues.
 *
 * Three log requests, and the third is not optional: the reserves a swap left behind
 * are in the `Sync` the same `_update` emitted immediately before it, in the same
 * block — which is what makes a pool price point exact rather than the trade's own
 * realised average. Same block, so same chunk, so a swap never loses its `Sync` to a
 * range boundary.
 */
const rowsIn =
  (
    client: LogScanClient,
    launchpad: Address,
    token: Address,
    pair: PoolQuote | undefined,
  ) =>
  async (r: Range): Promise<Trade[]> => {
    const span = { fromBlock: r.from, toBlock: r.to } as const;
    const [curve, swaps, syncs] = await Promise.all([
      client.getLogs({
        address: launchpad,
        event: TRADE_EVENT,
        args: { token },
        ...span,
      }),
      pair ? client.getLogs({ address: pair.pair, event: SWAP_EVENT, ...span }) : [],
      pair ? client.getLogs({ address: pair.pair, event: SYNC_EVENT, ...span }) : [],
    ]);

    const reserves = syncIndex(syncs, pair);
    return [
      ...curve.map(curveRow),
      ...(pair ? swaps.map((log) => poolRow(log, pair, reserves)) : []),
    ];
  };

async function readFeed(
  chain: Chain,
  launchpad: Address,
  token: Address,
): Promise<FeedState> {
  const deadline = Date.now() + DEEPEN_MS;
  const reads = serverClient(chain);
  const scan = logClient(chain);

  // Round 1: the head, with the DEX resolution riding along — the promise is created
  // before the await so its `router()` joins the same tick, and on a memo hit it
  // issues nothing at all.
  const dex = dexFor(reads, chain.id, launchpad);
  const latest = await reads.getBlockNumber();

  // Started here and awaited below, alongside the pair resolution rather than after
  // it — see the same note in /api/volume. Nothing but the head goes into it.
  const floorRead = deployBlock(reads, chain.id, launchpad, latest);
  void floorRead.catch(() => {});

  // The pair, if the curve has graduated into one. Resolved on every read rather than
  // memoised: this is the one place that would show a just-graduated token's first
  // pool trades, and a ten-minute memo would hide them.
  const resolved = await dex;
  const live = await pairsFor(reads, resolved, [token]);
  const quotes = await quotesFor(reads, resolved.weth, live);
  const pair = quotes[token.toLowerCase()];

  const floor = await floorRead;
  const from = floor.block;
  // Below this, logs are final and worth keeping. Above it, the sequencer may still
  // change its mind, so it is re-read every time.
  const settledTo = latest > from + REORG_TAIL ? latest - REORG_TAIL : from - 1n;

  const key = `${chain.id}:${token.toLowerCase()}`;
  const pairKey = pair ? pair.pair.toLowerCase() : null;
  const found = feeds.get(key);
  // Nothing kept, a deployment the record predates, or a pair it was built without.
  const held: Kept =
    found && found.lo >= from && found.pair === pairKey
      ? found
      : { rows: [], lo: settledTo + 1n, hi: settledTo, pair: pairKey };

  const read = rowsIn(scan, launchpad, token, pair);

  // The settled blocks that appeared since the last read, and the unsettled tail, in
  // one wave. They are independent ranges of one chunk each and there is no reason to
  // pay two round trips for them — on this endpoint a round trip is most of a second,
  // and it is a second the backfill below could have spent instead. What differs is
  // what happens to the rows: the forward sliver is settled and kept, the tail is
  // re-read every time and never kept.
  const ahead = ranges(held.hi + 1n, settledTo);
  const edges = await lanes([...ahead, ...ranges(settledTo + 1n, latest)], read, WAVE);
  if (ahead.length) {
    held.rows.push(...edges.slice(0, ahead.length).flat());
    held.hi = settledTo;
  }
  const tail = edges.slice(ahead.length).flat();

  // Backward: deepen until there are enough rows to fill a payload, or until this
  // read's {@link DEEPEN_MS} is spent. Stops at the first wave that satisfies either, so
  // a token with plenty of trades never touches its older chunks at all — and a quiet
  // one reaches further back on each read rather than all of it on one. The deadline is
  // handed over rather than polled between waves, so one hung request cannot overrun it.
  if (held.rows.length < ROWS && held.lo > from) {
    const { results, reached } = await newestChunksUntil(
      ranges(from, held.lo - 1n),
      read,
      (batch) => held.rows.length + batch.flat().length >= ROWS,
      WAVE,
      deadline,
    );
    held.rows.push(...results.flat());
    held.lo = reached;
  }

  // The unsettled tail was read above, in the same wave as the forward sliver.
  held.rows = newestFirst(held.rows).slice(0, ROWS);
  feeds.set(key, held);
  trim(feeds, FEEDS_MAX);

  const rows = newestFirst([...tail, ...held.rows]).slice(0, ROWS);
  await stampPoolRows(scan, chain.id, rows);

  return {
    chainId: chain.id,
    token,
    trades: rows,
    window: latest - held.lo + 1n,
    // Every trade this token has made, which is true only when the scan reached the
    // launchpad's own first block *and* that block was actually located.
    complete: held.lo <= from && floor.exact,
  };
}

/**
 * Fills in what a `Swap` log does not carry: when it happened, and who sent it.
 *
 * Both come out of the block, so this fetches the blocks the returned pool rows
 * landed in — with their transactions, which is where the trader's address is — and
 * nothing else. A few at a time, because public endpoints rate-limit bursts, and at
 * most `STAMP_BUDGET` per pass: a deep scan can turn up more pool blocks than it is
 * reasonable to ask for in one go, and the rows nobody has scrolled to yet can wait
 * for the next read.
 *
 * A block counts as missing when its stamp is absent *or* when some row in it still
 * has no sender. Without the second half, a block first seen through a page that
 * did not include this row would be cached as stamped and its sender never fetched,
 * leaving the trader as the `to` of the swap — which on a sell is the router, not a
 * person.
 */
async function stampPoolRows(
  client: LogScanClient,
  chainId: number,
  rows: Trade[],
) {
  const pool = rows.filter((r) => r.venue === "pool");
  if (pool.length === 0) return;

  const wanted = new Set(pool.map((r) => r.txHash.toLowerCase()));
  const incomplete = (r: Trade) =>
    !stamps.has(`${chainId}:${r.block}`) ||
    !senders.has(`${chainId}:${r.txHash.toLowerCase()}`);

  const missing = [...new Set(pool.filter(incomplete).map((r) => r.block))]
    // Newest first, so a budget-limited pass fills in what is on screen.
    .sort((a, b) => (a > b ? -1 : 1))
    .slice(0, STAMP_BUDGET);

  await lanes(
    missing,
    async (blockNumber) => {
      const block = await client.getBlock({ blockNumber, includeTransactions: true });
      stamps.set(`${chainId}:${blockNumber}`, Number(block.timestamp));
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        const hash = tx.hash.toLowerCase();
        if (wanted.has(hash)) senders.set(`${chainId}:${hash}`, tx.from);
      }
    },
    8,
  );

  trim(stamps, STAMP_MAX);
  trim(senders, SENDER_MAX);

  for (const row of rows) {
    if (row.venue !== "pool") continue;
    const at = stamps.get(`${chainId}:${row.block}`);
    if (at !== undefined) row.timestamp = at;
    row.trader = senders.get(`${chainId}:${row.txHash.toLowerCase()}`) ?? row.trader;
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const url = new URL(req.url);
  const chain = chainFrom(url);
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  const { token: raw } = await ctx.params;
  if (!isAddress(raw)) {
    return NextResponse.json({ error: "not an address" }, { status: 400 });
  }
  // Checksummed so the cache key is one entry per token rather than one per
  // spelling of it — same as /api/token.
  const token = getAddress(raw);

  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  try {
    const { value, stale } = await cached<FeedState>(
      `trades:${chain.id}:${token.toLowerCase()}`,
      MEMO_MS,
      () => readFeed(chain, launchpad, token),
    );

    const body: Wire<FeedState> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // A cold instance with no node, or the launchpad not deployed where it is
    // configured. The chart and the trade list are empty for everyone in this region
    // at this point.
    console.error(
      `[trades] ${token} on chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
