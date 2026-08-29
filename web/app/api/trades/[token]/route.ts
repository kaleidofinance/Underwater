import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address, type Chain } from "viem";
import { launchpadFor } from "@/lib/contracts";
import { SWAP_EVENT, SYNC_EVENT, TRADE_EVENT } from "@/lib/events";
import type { PoolQuote } from "@/lib/market";
import {
  curveRow,
  DEPTHS,
  NARROW,
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
  serverClient,
  type ServerClient,
} from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * One token's trades, scanned once for everybody.
 *
 * The dearest read in the app by a wide margin, and until now it ran per tab. A
 * `Trade` filter over a hundred thousand blocks plus the pair's `Swap` and `Sync`
 * over the same range is three `eth_getLogs`, and then up to sixty-four
 * `eth_getBlock`s with full transaction lists to recover what a `Swap` does not
 * carry: when it happened and who sent it. Every fifteen seconds, per open token
 * page, against an endpoint that rate-limits per IP — and lib/refresh.ts adds a
 * scan on every confirmed trade of the visitor's own on top.
 *
 * None of it is per-visitor: a token's history is a property of the chain. So it
 * moves behind the cache like the market did, with two differences that follow from
 * how much it costs. The window is ten seconds rather than three, because nothing
 * about a history is improved by being seven seconds fresher and the scan is two
 * orders of magnitude dearer than a multicall. And the block stamping now caches
 * across visitors rather than across one page's lifetime, which is where most of
 * the saving actually lands — the second reader of a busy token pays for no blocks
 * at all.
 *
 * `depth` is the one thing a caller may vary, and it is an index into a fixed list
 * rather than a block count, so the shared cache holds three entries per token
 * instead of one per span anybody cares to name.
 *
 * The pair is resolved here rather than accepted from the caller. `getPair` reads
 * back the zero address for a token still on its curve, so one cheap call answers
 * "is there a pool half to scan" without trusting a query parameter about it.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * Ten seconds at the edge, thirty of staleness allowed while it refreshes.
 *
 * The `stale-while-revalidate` is doing more work here than anywhere else: a cold
 * scan is seconds of round trips, and this is the read most likely to be refused
 * outright by a public endpoint asked for too wide a range. Serving a slightly
 * behind history beats an empty chart.
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

async function readFeed(
  chain: Chain,
  launchpad: Address,
  token: Address,
  depth: number,
): Promise<FeedState> {
  const client = serverClient(chain);

  // Round 1: the head, with the DEX resolution riding along — the promise is
  // created before the await so its `router()` joins the same tick, and on a memo
  // hit it issues nothing at all.
  const dex = dexFor(client, chain.id, launchpad);
  const latest = await client.getBlockNumber();

  // The pair, if the curve has graduated into one. `quotesFor` reads reserves this
  // does not need, but it is the one place that decides which leg of a `Swap` is
  // ETH, and a second copy of that decision is exactly how a feed comes to report
  // buys as sells.
  const resolved = await dex;
  const live = await pairsFor(client, resolved, [token]);
  const quotes = await quotesFor(client, resolved.weth, live);
  const pair = quotes[token.toLowerCase()];

  // Anvil starts at block 0 and has no range cap, so scan the whole chain.
  const wide = chain.id === 31337 ? latest : DEPTHS[depth];
  const windows = wide > NARROW ? [wide, NARROW] : [wide];

  let lastError: unknown;
  for (const span of windows) {
    const from = span >= latest ? 0n : latest - span;
    try {
      const trades = await scan(client, chain.id, {
        launchpad,
        token,
        pair,
        from,
        to: latest,
      });
      return {
        chainId: chain.id,
        token,
        trades,
        window: latest - from,
        complete: from === 0n,
        wide: span === wide,
      };
    } catch (e) {
      // Almost always the endpoint refusing the range, which is why there is a
      // narrower window to fall back to rather than an error to report. Logged all
      // the same: a refusal and a bug in the scan are indistinguishable from the
      // outside once the fallback has quietly succeeded, and one of them silently
      // costs every visitor the wide window they could have had.
      console.warn(
        `[trades] ${span} blocks refused on chain ${chain.id}:`,
        e instanceof Error ? e.message : e,
      );
      lastError = e;
    }
  }
  throw lastError;
}

async function scan(
  client: ServerClient,
  chainId: number,
  q: {
    launchpad: Address;
    token: Address;
    pair: PoolQuote | undefined;
    from: bigint;
    to: bigint;
  },
): Promise<Trade[]> {
  const range = { fromBlock: q.from, toBlock: q.to } as const;
  const { pair } = q;

  const [curve, swaps, syncs] = await Promise.all([
    client.getLogs({
      address: q.launchpad,
      event: TRADE_EVENT,
      args: { token: q.token },
      ...range,
    }),
    pair ? client.getLogs({ address: pair.pair, event: SWAP_EVENT, ...range }) : [],
    pair ? client.getLogs({ address: pair.pair, event: SYNC_EVENT, ...range }) : [],
  ]);

  const reserves = syncIndex(syncs, pair);
  const rows = newestFirst([
    ...curve.map(curveRow),
    ...(pair ? swaps.map((log) => poolRow(log, pair, reserves)) : []),
  ]).slice(0, ROWS);

  await stampPoolRows(client, chainId, rows);
  return rows;
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
  client: ServerClient,
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

  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (blockNumber) => {
        const block = await client.getBlock({
          blockNumber,
          includeTransactions: true,
        });
        stamps.set(`${chainId}:${blockNumber}`, Number(block.timestamp));
        for (const tx of block.transactions) {
          if (typeof tx === "string") continue;
          const hash = tx.hash.toLowerCase();
          if (wanted.has(hash)) senders.set(`${chainId}:${hash}`, tx.from);
        }
      }),
    );
  }

  trim(stamps, STAMP_MAX);
  trim(senders, SENDER_MAX);

  for (const row of rows) {
    if (row.venue !== "pool") continue;
    const at = stamps.get(`${chainId}:${row.block}`);
    if (at !== undefined) row.timestamp = at;
    row.trader = senders.get(`${chainId}:${row.txHash.toLowerCase()}`) ?? row.trader;
  }
}

/**
 * An index into {@link DEPTHS}, clamped rather than rejected.
 *
 * Clamped because the number is a cache key: a rejected `?depth=7` is a 400 nobody
 * asked for, but an *accepted* one would be a memo entry per value anybody cares to
 * send, which is a cheap way to make a shared cache useless.
 */
function depthFrom(url: URL): number {
  const raw = Number(url.searchParams.get("depth") ?? 0);
  if (!Number.isInteger(raw)) return 0;
  return Math.min(Math.max(raw, 0), DEPTHS.length - 1);
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
  const depth = depthFrom(url);

  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  try {
    const { value, stale } = await cached<FeedState>(
      `trades:${chain.id}:${token.toLowerCase()}:${depth}`,
      MEMO_MS,
      () => readFeed(chain, launchpad, token, depth),
    );

    const body: Wire<FeedState> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // Both windows refused, or a cold instance with no node. The chart and the
    // trade list are empty for everyone in this region at this point.
    console.error(
      `[trades] ${token} on chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
