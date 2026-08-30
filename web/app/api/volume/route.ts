import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import {
  deployBlock,
  lanes,
  newestChunksUntil,
  ranges,
  REORG_TAIL,
  type Range,
} from "@/lib/chunks";
import { launchpadFor } from "@/lib/contracts";
import {
  SWAP_EVENT,
  swapEth,
  TRADE_EVENT,
  type SwapArgs,
  type TradeArgs,
} from "@/lib/events";
import type { Volume } from "@/lib/scans";
import { dexFor, pairsFor, quotesFor } from "@/lib/server-dex";
import { allTokens } from "@/lib/server-launchpad";
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
 * What the market has done, all of it, scanned once for everybody.
 *
 * This used to be a hundred-thousand-block window that the endpoint refused and
 * silently narrowed to nine thousand — so the number under "Volume" was the last two
 * and a half hours of trading, labelled as if it were more. Now it reaches back to the
 * block the launchpad was deployed in, which on Ink Sepolia is 386,000 blocks: 43
 * requests the endpoint will actually answer, instead of one it will not.
 *
 * Affording that means never doing it twice, and never doing it all at once. Logs in a
 * block that can no longer be reorganised do not change, so the total over everything
 * below the reorg tail is kept and extended: each read counts the new blocks at the
 * head and then spends {@link REACH_MS} reaching further back than the last one. A cold
 * instance is therefore answering in seconds with a total of recent trading, and has
 * the whole history a few reads later — rather than making the first visitor wait out
 * the entire sweep before seeing a number.
 *
 * A running total rather than the logs themselves, deliberately. A few numbers per
 * chain cannot grow into a memory problem the way a hundred thousand decoded rows
 * would, and a total is all this route has ever returned.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * Twenty seconds, matching the interval the hook already polled at.
 *
 * The loosest window of the four routes, because this is the number least sensitive
 * to being slightly behind: an all-time total does not visibly change in twenty
 * seconds. It is also the window that absorbs a backfill step, which is the one read
 * here that is not nearly instant.
 */
const MEMO_MS = 20_000;
const EDGE_S = 20;
const SWR_S = 120;

/**
 * How long a token list may be stale before the total is recomputed against a new
 * one. Ten minutes is fine because being late to notice a graduation costs nothing:
 * the pair's swaps are picked up whenever it is noticed, over the whole range, by
 * the catch-up below.
 */
const TOKENS_MEMO_MS = 10 * 60_000;

/**
 * Wall clock one read will spend reaching backwards, in milliseconds.
 *
 * The reason a bound exists at all: 88 chunks of Ink Sepolia history measured 39
 * seconds, and holding the first visitor's request open for that long to build a number
 * that is already useful at "recent trading" is the wrong trade.
 *
 * **It is a latency bound, not a survival one — which is a correction.** This was 7s,
 * aimed at "the ten-second default a Node function gets on Vercel's cheapest plan", and
 * that ceiling does not exist: with fluid compute (on by default) Hobby's default *and*
 * maximum are both 300s, the project reports `functionDefaultTimeout: 300`, and a
 * production request was measured running 59s and returning 200. The note that used to
 * sit here about `export const maxDuration` was true — it does break `next build` on
 * 15.5.23, the same trap `revalidate` set (see /api/head) — but moot, because there was
 * never a default that needed raising. The tell was two paragraphs down all along: the
 * pre-work below has been measured at 31 seconds with "no wave to abandon there", and
 * under a real 10s ceiling that would have failed every cold read rather than merely
 * being slow.
 *
 * The reason it is a clock and not a chunk count, which is what this was first: the
 * same fifteen chunks took 4 seconds on a good minute and 13 on a bad one, and Ink's
 * public endpoint has both. A count bounds the work; only a clock bounds the *request*.
 * On a fast endpoint this also converges further per read rather than leaving time
 * unspent.
 *
 * Measured from the start of the handler, so the floor search and the token list are
 * inside it. Twenty seconds, chosen to converge Ink Sepolia's history in a read or two
 * instead of a dozen while still returning early enough that nobody waits on a total
 * that reads fine when it is partial. The clock is enforced per wave rather than merely
 * consulted between them — the first version of this checked it between waves and was
 * blown straight through by single waves of 26 and 45 seconds, because a request left to
 * its own timeout and retries can outlast the whole budget several times over. See
 * `newestChunksUntil` in lib/chunks.ts.
 *
 * What it still cannot bound is the pre-work above it: a cold instance's deployment
 * search was measured at 31 seconds on a bad minute, and there is no wave to abandon
 * there. That is a public-endpoint problem rather than a structural one — it is one
 * search, memoised forever, and 2.4 seconds when the endpoint is behaving.
 *
 * There is always one wave, so every read makes progress even when the pre-work has
 * already spent the budget. `allTime` is false until it gets there, so a total still
 * growing says so.
 */
const REACH_MS = 20_000;

/** Chunks in flight per wave. Each chunk is two log requests, one per venue. */
const WAVE = 3;

type Part = { eth: bigint; trades: number };
const ZERO: Part = { eth: 0n, trades: 0 };
const plus = (a: Part, b: Part): Part => ({
  eth: a.eth + b.eth,
  trades: a.trades + b.trades,
});

/** Pairs that still owe their share of a range already counted without them. */
type Owed = { pairs: Address[]; from: bigint; to: bigint };

/**
 * The settled total and how much of history it covers, per launchpad.
 *
 * `[lo, hi]` is the settled range counted, and it grows in both directions: `hi`
 * follows the head every read, `lo` reaches as far back as {@link REACH_MS} allows.
 * Counting from the head *downwards* rather than from the floor upwards is what keeps
 * a partial total useful — it is always the most recent trading, never a prefix that
 * is missing today's.
 *
 * `owed` is the awkward case, and it is the one worth spelling out. A token graduating
 * adds a pair address that was never scanned over `[lo, hi]`, so its earlier swaps are
 * not in the total and never would be. The alternative to this queue is throwing the
 * pool total away and rebuilding it, which would make the market's volume visibly
 * *drop* the moment a token succeeded — the exact moment it should not.
 *
 * Keyed by launchpad address as well as chain. A total accumulated from one
 * deployment's floor cannot be extended onto another's, and the two would otherwise
 * share an entry and quietly add up to neither.
 */
type Store = {
  total: Part;
  lo: bigint;
  hi: bigint;
  pairs: Set<string>;
  owed: Owed[];
};

const stores = new Map<string, Store>();

/** The curve's ETH over one range: the trade amount, fee included, gross volume. */
const curveIn =
  (client: LogScanClient, launchpad: Address) =>
  async (r: Range): Promise<Part> => {
    const logs = await client.getLogs({
      address: launchpad,
      // No `args` filter: this is every token's trades, not one token's.
      event: TRADE_EVENT,
      fromBlock: r.from,
      toBlock: r.to,
    });
    let eth = 0n;
    for (const log of logs) eth += (log.args as TradeArgs).ethAmount ?? 0n;
    return { eth, trades: logs.length };
  };

/**
 * The pools' ETH over one range, for a set of pairs at once.
 *
 * `eth_getLogs` takes a list of addresses, which is what keeps this one request per
 * range rather than one per pair per range — the difference between 43 requests and
 * 43 times however many tokens have graduated.
 */
const poolIn =
  (client: LogScanClient, pairs: readonly Address[], wethIsToken0: Map<string, boolean>) =>
  async (r: Range): Promise<Part> => {
    if (pairs.length === 0) return ZERO;
    const logs = await client.getLogs({
      address: pairs as Address[],
      event: SWAP_EVENT,
      fromBlock: r.from,
      toBlock: r.to,
    });
    let eth = 0n;
    let trades = 0;
    for (const log of logs) {
      const side = wethIsToken0.get(log.address.toLowerCase());
      if (side === undefined) continue;
      eth += swapEth(log.args as SwapArgs, side);
      trades++;
    }
    return { eth, trades };
  };

async function readVolume(chain: Chain, launchpad: Address): Promise<Volume> {
  const deadline = Date.now() + REACH_MS;
  const reads = serverClient(chain);
  const scan = logClient(chain);

  // Round 1: the head, with the DEX resolution riding along — created before the
  // await so its `router()` joins the same tick, and free on a memo hit.
  const dex = dexFor(reads, chain.id, launchpad);
  const latest = await reads.getBlockNumber();

  // Started here and awaited below. Locating the deployment is a search of its own —
  // measured at five seconds against a public endpoint — and it needs nothing but the
  // head, so there is no reason for it to queue behind the token list or the token
  // list behind it. Free on every read after the first, since the answer cannot
  // change and is memoised forever.
  const floorRead = deployBlock(reads, chain.id, launchpad, latest);
  // Observed now so that a failure in the read below does not leave this rejection
  // unhandled. Awaiting it still throws.
  void floorRead.catch(() => {});

  // Every launch, not the newest page of them: a total over a window is not a total.
  // Memoised, because resolving pairs for a large market is the only part of this
  // that costs contract reads rather than log requests.
  const { value: pairs } = await cached(`volume-pairs:${chain.id}`, TOKENS_MEMO_MS, async () => {
    const { tokens } = await allTokens(reads, launchpad);
    const resolved = await dex;
    const live = await pairsFor(reads, resolved, tokens);
    // Reserves come along unused. `quotesFor` is the one place that decides which leg
    // of a `Swap` is ETH, and a second copy of that decision is exactly how a total
    // comes to count sells twice and buys not at all.
    return Object.values(await quotesFor(reads, resolved.weth, live));
  });

  const addresses = pairs.map((p) => p.pair);
  const wethIsToken0 = new Map(
    pairs.map((p) => [p.pair.toLowerCase(), p.wethIsToken0] as const),
  );

  const floor = await floorRead;
  const from = floor.block;

  // Everything below this is final and worth keeping; everything above it is the
  // sequencer's to change its mind about and is re-read every time.
  const settledTo = latest > from + REORG_TAIL ? latest - REORG_TAIL : from - 1n;

  const key = `${chain.id}:${launchpad.toLowerCase()}`;
  const found = stores.get(key);
  // An empty range just below the tail: nothing counted, everything still to reach.
  // Also where a record that cannot be reconciled with this floor starts again.
  const held: Store =
    found && found.lo >= from && found.lo <= settledTo + 1n
      ? found
      : {
          total: ZERO,
          lo: settledTo + 1n,
          hi: settledTo,
          pairs: new Set<string>(),
          owed: [],
        };

  const curveRead = curveIn(scan, launchpad);
  const poolRead = poolIn(scan, addresses, wethIsToken0);
  /** One chunk, both venues. */
  const both = (r: Range) =>
    Promise.all([curveRead(r), poolRead(r)]).then(([c, p]) => plus(c, p));

  /* Nothing below this point touches `held` — every request is issued and awaited
   * first, and only then is the store written. If a chunk fails the whole read throws,
   * `cached` serves the previous answer, and the store is exactly as it was; a
   * half-applied update would mark work done that never happened and lose those trades
   * for the life of the instance. */

  // Pairs learned about since the last read owe their share of the counted range.
  const fresh = addresses.filter((a) => !held.pairs.has(a.toLowerCase()));
  const owed: Owed[] =
    fresh.length && held.hi >= held.lo
      ? [...held.owed, { pairs: fresh, from: held.lo, to: held.hi }]
      : held.owed;

  // The work whose size is not a choice: the settled blocks that appeared since the
  // last read, which is one chunk on a warm instance and none on a cold one, and the
  // unsettled tail, which is re-read every time and never kept.
  const jobs: { settled: boolean; range: Range }[] = [
    ...ranges(held.hi + 1n, settledTo).map((range) => ({ settled: true, range })),
    ...ranges(settledTo + 1n, latest).map((range) => ({ settled: false, range })),
  ];
  const parts = await lanes(jobs, (j) => both(j.range), WAVE);

  // Backward, until the clock says stop: newest chunks first, so the range counted
  // stays contiguous with the head and a partial total is always recent trading rather
  // than a prefix missing today's. The deadline goes in rather than being polled here,
  // so a wave that hangs is abandoned instead of overrunning the whole read.
  let lo = held.lo;
  let back = ZERO;
  let ranOut = false;
  const behind = ranges(from, held.lo - 1n);
  if (behind.length) {
    const walk = await newestChunksUntil(behind, both, () => false, WAVE, deadline);
    back = walk.results.reduce(plus, back);
    lo = walk.reached;
    ranOut = walk.ranOut;
  }

  // The graduation queue, with whatever time is left. Pool logs only: a new pair
  // changes nothing about what the curve did.
  const nextOwed: Owed[] = [];
  for (const o of owed) {
    const chunks = ranges(o.from, o.to);
    if (!chunks.length) continue;
    if (Date.now() > deadline) {
      nextOwed.push(o);
      continue;
    }
    const late = poolIn(scan, o.pairs, wethIsToken0);
    const { results, reached } = await newestChunksUntil(
      chunks,
      late,
      () => false,
      WAVE,
      deadline,
    );
    back = results.reduce(plus, back);
    if (reached - 1n >= o.from) nextOwed.push({ ...o, to: reached - 1n });
  }

  let settled = plus(held.total, back);
  let tail = ZERO;
  parts.forEach((part, i) => {
    if (jobs[i].settled) settled = plus(settled, part);
    else tail = plus(tail, part);
  });

  if (lo > from || nextOwed.length) {
    console.log(
      `[volume] chain ${chain.id}: counted ${lo}–${settledTo} of ${from}, ` +
        `${behind.length - ranges(from, lo - 1n).length}/${behind.length} chunks this read` +
        `${ranOut ? " (out of time)" : ""}, ${nextOwed.length} pairs behind`,
    );
  }

  stores.set(key, {
    total: settled,
    lo,
    hi: settledTo,
    pairs: new Set([...held.pairs, ...addresses.map((a) => a.toLowerCase())]),
    owed: nextOwed,
  });

  const all = plus(settled, tail);
  return {
    eth: all.eth,
    trades: all.trades,
    blocks: latest - lo + 1n,
    // Every trade the market has ever made — which needs the scan to have reached the
    // floor, every late pair to have caught up, and the floor itself to be the real
    // deployment block rather than a fallback. See `Floor` in lib/chunks.ts.
    allTime: lo <= from && nextOwed.length === 0 && floor.exact,
  };
}

export async function GET(req: Request) {
  const chain = chainFrom(new URL(req.url));
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  try {
    const { value, stale } = await cached<Volume>(
      `volume:${chain.id}`,
      MEMO_MS,
      () => readVolume(chain, launchpad),
    );

    const body: Wire<Volume> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // A cold instance with no node, or the launchpad not deployed where it is
    // configured. MarketStats renders its unavailable state and the other three
    // cards are unaffected.
    console.error(
      `[volume] chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
