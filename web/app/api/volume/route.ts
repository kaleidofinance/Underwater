import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { launchpadAbi } from "@/lib/abis";
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
  GRADUATED_EVENT,
  SWAP_EVENT,
  swapEth,
  TRADE_EVENT,
  type GraduatedArgs,
  type SwapArgs,
  type TradeArgs,
} from "@/lib/events";
import type { Volume } from "@/lib/scans";
import { dexFor, feeToFor, pairsFor, quotesFor } from "@/lib/server-dex";
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
 *
 * It returns revenue as well as volume, and revenue is every product's rather than the
 * curves': a launch pays a flat `creationFee`, a curve trade pays `tradeFeeBps`, a
 * graduation pays `graduationFeeBps` on its way to the DEX, and a pool swap pays the
 * DEX's sixth of its 0.3%. The first three end up with the launchpad's `feeRecipient`
 * and the fourth with the factory's `feeTo`, which on this deployment is the same
 * address. Three of the four are counted off logs this scan was already fetching, so the
 * whole of it costs one contract read and no extra requests — see `Fees` in lib/scans.ts
 * for what each leg is worth trusting to the wei, and {@link POOL_CUT_BPS} for the one
 * that is derived rather than read.
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

/**
 * The protocol's share of a pool swap, in basis points of the ETH that moved.
 *
 * The DEX charges 0.3% and `UnderwaterPair._mintFee` mints `feeTo` a sixth of it —
 * "0.05% of volume out of the pool's 0.3%", in the contract's own words. So the cut on
 * a swap is five basis points of the swap, and this is the one leg of the fee total
 * that is derived rather than read: nothing logs it, because it is never paid per swap.
 * It accrues as *unminted* LP against the pool's √k and is realised only when somebody
 * adds or removes liquidity — which, for a graduated pool whose base LP is burned to
 * dead, is nobody.
 *
 * Derived from volume rather than read off the pools deliberately, and the difference
 * is a difference of meaning. lib/protocol.ts reads the exact claim — `balanceOf(feeTo)`
 * plus the √k accrual, valued at the pool's price — and that is the right number for
 * the owner, who is deciding whether to collect it. It is the wrong number here: it is
 * what is claimable *now*, so it drops to zero the first time it is collected, and a
 * figure headed "all time" that fell after taking some revenue would be lying about
 * both. Volume × 5 bps is cumulative, costs no request, and is what was earned.
 *
 * Approximate in one direction only. The ETH side is exact for a buy, where the 0.3% is
 * charged on the ETH going in; for a sell it is charged on the tokens going in, and the
 * ETH coming out is already net of it, so the base is a hair low.
 */
const POOL_CUT_BPS = 5n;
const BPS = 10_000n;

/**
 * One range of history, counted.
 *
 * `poolEth` is the pool share of `eth` rather than a total of its own, and it is kept
 * apart for exactly one reason: the protocol's cut of a swap appears in no log, so it
 * has to be derived from pool volume (see {@link POOL_CUT_BPS}). In every other respect
 * a swap and a curve trade are the same event to this route.
 *
 * The two fee fields are what the logs state outright, which is why they are separate
 * from each other and from the two legs computed at the end: a sum of exact numbers and
 * derived ones should still be able to say which part was which.
 */
type Part = {
  eth: bigint;
  poolEth: bigint;
  trades: number;
  /** `Trade.feeAmount` — the curve fee, exactly as the contract took it. */
  curveFees: bigint;
  /** `Graduated.protocolFee` — once per token that filled its curve. */
  gradFees: bigint;
};
const ZERO: Part = { eth: 0n, poolEth: 0n, trades: 0, curveFees: 0n, gradFees: 0n };
const plus = (a: Part, b: Part): Part => ({
  eth: a.eth + b.eth,
  poolEth: a.poolEth + b.poolEth,
  trades: a.trades + b.trades,
  curveFees: a.curveFees + b.curveFees,
  gradFees: a.gradFees + b.gradFees,
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

/**
 * What the launchpad did over one range: the ETH that moved on the curves, and the two
 * fees it charged that a log will admit to.
 *
 * Both events on one request. `eth_getLogs` accepts a list of topics for position zero,
 * which viem spells `events: [...]`, so adding graduations to a scan that was already
 * reading trades costs nothing at all — no extra round trip, no extra chunk, the same
 * 43 requests over Ink Sepolia's history. That mattered enough to be worth saying: the
 * obvious shape, a second scan for a second event, would have been a third request per
 * chunk for an event that fires twice in a market's lifetime.
 *
 * `feeAmount` is what the contract actually took on that trade, so the total is a sum of
 * what happened rather than volume multiplied by today's rate. Those stop being the same
 * number the moment `tradeFeeBps` is changed, and only one of them is revenue.
 *
 * `trades` counts trades. A graduation is a fee, not a trade, and folding it into the
 * count would put a number under "Volume" that no longer matches the rows anybody can
 * scroll through.
 */
const launchpadIn =
  (client: LogScanClient, launchpad: Address) =>
  async (r: Range): Promise<Part> => {
    const logs = await client.getLogs({
      address: launchpad,
      // No `args` filter: this is every token's trades, not one token's.
      events: [TRADE_EVENT, GRADUATED_EVENT],
      fromBlock: r.from,
      toBlock: r.to,
    });
    let eth = 0n;
    let curveFees = 0n;
    let gradFees = 0n;
    let trades = 0;
    for (const log of logs) {
      if (log.eventName === "Graduated") {
        gradFees += (log.args as GraduatedArgs).protocolFee ?? 0n;
        continue;
      }
      const a = log.args as TradeArgs;
      eth += a.ethAmount ?? 0n;
      curveFees += a.feeAmount ?? 0n;
      trades++;
    }
    return { eth, poolEth: 0n, trades, curveFees, gradFees };
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
    // No fee here, and none is missing: a swap's 0.3% stays in the pool, which makes it
    // the LPs' income — the same line `Trade.fee` draws in lib/scans.ts. The protocol's
    // sixth of it is not paid per swap and cannot be summed from these logs, so it is
    // derived from `poolEth` once, at the end. See {@link POOL_CUT_BPS}.
    return { eth, poolEth: eth, trades, curveFees: 0n, gradFees: 0n };
  };

async function readVolume(chain: Chain, launchpad: Address): Promise<Volume> {
  const deadline = Date.now() + REACH_MS;
  const reads = serverClient(chain);
  const scan = logClient(chain);

  // Round 1: the head, with the DEX resolution riding along — created before the
  // await so its `router()` joins the same tick, and free on a memo hit.
  const dex = dexFor(reads, chain.id, launchpad);

  // The launch leg of revenue, and the only one that is not a log. `creationFee` is
  // charged per launch and forwarded on the spot, so what the protocol has taken is
  // every launch there has ever been times the fee — `tokenCount` being the contract's
  // own counter, which makes this leg exact and complete on the first read, while the
  // log legs are still reaching backwards.
  //
  // The one way it can be wrong: the fee is settable, and a change would re-value every
  // launch that happened before it at the new price. It has never been changed on either
  // deployment. If it ever is, `CreationFeeUpdated(oldFee, newFee)` is the timeline that
  // would attribute each launch to the fee in force at its block.
  //
  // Created before the await so both reads leave with the head rather than after it.
  const launchRead = Promise.all([
    reads.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "tokenCount",
    }),
    reads.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "creationFee",
    }),
  ]) as Promise<[bigint, bigint]>;
  void launchRead.catch(() => {});

  // Whether the DEX fee switch is even on. Chained off `dex` because it needs the
  // factory address, and awaited at the very end so it overlaps the whole log scan.
  const cutRead = dex.then((d) => feeToFor(reads, chain.id, d.factory));
  void cutRead.catch(() => {});

  const latest = await reads.getBlockNumber();

  // Awaited here rather than at the end: both reads went out with the head, so the
  // answer is already in hand, and learning now that the endpoint will not answer beats
  // learning it after twenty seconds of scanning.
  const [tokenCount, creationFee] = await launchRead;

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

  const padRead = launchpadIn(scan, launchpad);
  const poolRead = poolIn(scan, addresses, wethIsToken0);
  /** One chunk, both venues. */
  const both = (r: Range) =>
    Promise.all([padRead(r), poolRead(r)]).then(([c, p]) => plus(c, p));

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

  // The two legs no log carries. `launch` is complete however far the scan has reached,
  // because it comes off a counter rather than a range; `pool` is only ever as complete
  // as the pool volume it is a share of, and is zero outright while the fee switch is
  // off — see `feeToFor`.
  const launch = tokenCount * creationFee;
  const pool = (await cutRead) ? (all.poolEth * POOL_CUT_BPS) / BPS : 0n;

  return {
    eth: all.eth,
    trades: all.trades,
    fees: {
      launch,
      curve: all.curveFees,
      graduation: all.gradFees,
      pool,
      total: launch + all.curveFees + all.gradFees + pool,
    },
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
