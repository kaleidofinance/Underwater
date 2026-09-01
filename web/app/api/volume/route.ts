import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { launchpadAbi } from "@/lib/abis";
import {
  deployBlock,
  lanes,
  newestChunksUntil,
  ranges,
  scanPolicy,
  type Range,
} from "@/lib/chunks";
import { launchpadFor } from "@/lib/contracts";
import { spotPriceE18 } from "@/lib/curve";
import {
  GRADUATED_EVENT,
  SWAP_EVENT,
  swapEth,
  SYNC_EVENT,
  TOKEN_CREATED_EVENT,
  TRADE_EVENT,
  type GraduatedArgs,
  type SwapArgs,
  type SyncArgs,
  type TradeArgs,
} from "@/lib/events";
import {
  indexedVolume,
  type IndexedVolume,
  type IndexedWindow,
} from "@/lib/indexer";
import { MARKET_LIMIT } from "@/lib/market";
import type { Fees, Opens, Volume } from "@/lib/scans";
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
 * It returns a rolling twenty-four hours beside the lifetime figure, and that is the one
 * thing a running total cannot do by itself: a total only grows, so a window has to be
 * able to forget. It forgets in minutes — each log lands in the total *and* in a bucket
 * keyed by its minute, and buckets older than a day are dropped on the next read. See
 * {@link DAY_S}. It costs no request: the logs were being read anyway.
 *
 * The same window is where the market list's 24-hour price change comes from, which is the
 * one thing here that is per launch rather than per market. It is the same trick and the
 * same logs: a curve `Trade` states the reserves it left behind and a pair's `Sync` states
 * its own, so the price at every point in the day is already in this scan — what a change
 * needs on top is the price at the *start* of the window, which is a scan that remembers
 * rather than one that sums. See {@link Marks}, and `Day.opens` in lib/scans.ts for what
 * crosses the wire. A rescan of the day per read would be ten more chunk requests every
 * twenty seconds against an endpoint this codebase has measured dropping nineteen of forty.
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
 *
 * **And all of it is skipped where an indexer is available** — see `indexedVolume` and
 * {@link volumeOf}. Everything above is what it takes to answer this question from an
 * endpoint that will only hand over nine thousand blocks at a time; a database that has
 * already read them answers it with four aggregates. Two things get strictly better and
 * are worth naming, because they are the reasons to prefer it rather than side effects of
 * it. The day becomes a real 86,400 seconds on the first read instead of however far the
 * reach got, on any chain, including one that declares no block time. And the launch leg
 * of revenue becomes a sum of what each launch paid instead of every launch ever times
 * *today's* fee — which on Ink Sepolia is the difference between 0.00122 ETH of invented
 * revenue and the zero that was actually charged.
 *
 * The scan is not a legacy path. It is what answers with nothing deployed but the
 * contracts, and what answers while a backfill is still running — and it is honest about
 * a partial history in a way a `SELECT` cannot be, which is why the indexer is not
 * consulted at all until it can claim a whole one.
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
 * The rolling window, and the grain it is summed at.
 *
 * A card headed "24hrs" has to be twenty-four hours or it is a label over the wrong
 * number, and the cumulative total this route was built to keep is the wrong number by
 * construction: it only grows. So the scan also files what it counts into buckets near
 * the head, and the day is the buckets that have not aged out yet.
 *
 * A minute is the grain because the cost of this is entirely the number of buckets held,
 * not their contents: 1,440 of them cover a day whether the market did four trades in it
 * or four hundred thousand, where keeping the logs themselves would scale with traffic on
 * an instance that has no business holding a day of trades in memory. What a grain costs
 * instead is precision at the edge — the oldest bucket is kept whole, so the window is up
 * to one minute wider than a day. On a figure someone reads to see whether the market is
 * busy, sixty seconds of slack in eighty-six thousand is not a number anybody can see.
 *
 * Both are seconds and are converted to blocks per chain, off the `blockTime` those
 * declare. A chain that declares none gets no window at all rather than a guessed one —
 * see `grainOf`.
 */
const DAY_S = 86_400;
const GRAIN_S = 60;

/**
 * The grain the *prices* in the window are kept at, which is coarser than the volume's
 * and for a different reason.
 *
 * A price bucket holds one price rather than a sum, so its cost is per token: the market
 * list shows {@link MARKET_LIMIT} launches, and a minute grain would be 1,440 prices for
 * each of them held by an instance whose job is to answer with a handful of numbers. Five
 * minutes is 288, and what it costs is precision on the *reference* price — the open can
 * be up to five minutes older than exactly a day ago, on a figure that is a percentage of
 * a day's movement. Nothing a reader can see.
 *
 * It buys nothing on the window's near edge and is not used there: which side of the day
 * floor a price sits on is decided per price, off its own block, so the day the change is
 * measured over is a day and not a day and a bucket. See the prune in `readVolume`.
 */
const PRICE_GRAIN_S = 300;

/** Where the day starts and how wide a bucket is, both in blocks on this chain. */
type Grain = {
  from: bigint;
  size: bigint;
  /** {@link PRICE_GRAIN_S} in blocks — the grain of the per-token price track. */
  priceSize: bigint;
  blockS: number;
};

/**
 * The day window in this chain's blocks, or nothing if it cannot be expressed in them.
 *
 * `blockTime` is a declared chain parameter (lib/chains.ts) and every chain in the
 * registry fixes one. Anvil declares none, because it mines on demand unless it was
 * started with `--block-time`: there is no interval, so there is no window, and the route
 * says so with a null rather than inventing one. The card falls back to the cumulative
 * figure, and the market list shows no 24-hour change.
 */
function grainOf(chain: Chain, latest: bigint): Grain | undefined {
  const ms = chain.blockTime;
  if (!ms) return undefined;
  const blockS = ms / 1000;
  const day = BigInt(Math.max(1, Math.round(DAY_S / blockS)));
  const size = BigInt(Math.max(1, Math.round(GRAIN_S / blockS)));
  const priceSize = BigInt(Math.max(1, Math.round(PRICE_GRAIN_S / blockS)));
  return {
    from: latest > day ? latest - day + 1n : 0n,
    size,
    priceSize,
    blockS,
  };
}

/**
 * One range of history, counted.
 *
 * `poolEth` is the pool share of `eth` rather than a total of its own, and it is kept
 * apart for exactly one reason: the protocol's cut of a swap appears in no log, so it
 * has to be derived from pool volume (see {@link POOL_CUT_BPS}). In every other respect
 * a swap and a curve trade are the same event to this route.
 *
 * The fee fields are what the logs state outright, which is why they are separate from
 * each other and from the two legs computed at the end: a sum of exact numbers and
 * derived ones should still be able to say which part was which. `launches` is a count
 * for the same reason — the fee it is worth is a contract read, not a log, so the log
 * side counts and the arithmetic happens once, at the end.
 */
type Part = {
  eth: bigint;
  poolEth: bigint;
  trades: number;
  /** `Trade.feeAmount` — the curve fee, exactly as the contract took it. */
  curveFees: bigint;
  /** `Graduated.protocolFee` — once per token that filled its curve. */
  gradFees: bigint;
  /** `TokenCreated` events, each of which paid `creationFee`. */
  launches: number;
};
const ZERO: Part = {
  eth: 0n,
  poolEth: 0n,
  trades: 0,
  curveFees: 0n,
  gradFees: 0n,
  launches: 0,
};
const plus = (a: Part, b: Part): Part => ({
  eth: a.eth + b.eth,
  poolEth: a.poolEth + b.poolEth,
  trades: a.trades + b.trades,
  curveFees: a.curveFees + b.curveFees,
  gradFees: a.gradFees + b.gradFees,
  launches: a.launches + b.launches,
});

/**
 * A price, and where on the chain it was left behind.
 *
 * The position is carried because the scan does not meet these in order: chunks are read
 * newest-first, the backward walk arrives at older ones over later reads, and a graduation
 * queue can bring a pair's history in long after the range around it was counted. So
 * "which of these two prices is the later one" is a comparison rather than an arrival
 * order, and `logIndex` is in it because a block can hold two trades of the same token.
 */
type Tick = { at: bigint; seq: number; priceE18: bigint };

/**
 * One token's prices near the head: the last one before the window, and one per bucket
 * inside it.
 *
 * `before` is the answer to the only question the market list asks — what this cost
 * twenty-four hours ago — and it exists so that a token which has not traded all day
 * still has one. Without it a quiet launch would have no reference price and the list
 * would show nothing beside it, when the truthful answer is that it has not moved.
 *
 * The buckets are what makes that survive the window sliding forward: each read, prices
 * that have aged past the floor collapse into `before` and the next one takes over. A
 * single stored price could not — the window would slide past it and there would be
 * nothing behind it to advance to.
 */
type Marks = { before?: Tick; at: Map<bigint, Tick> };

/** Whichever of two prices the chain left behind later. */
const later = (held: Tick | undefined, one: Tick): Tick =>
  !held || one.at > held.at || (one.at === held.at && one.seq > held.seq) ? one : held;

/** And earlier — what the window opened at, once the oldest price in it is known. */
const earlier = (held: Tick | undefined, one: Tick): Tick =>
  !held || one.at < held.at || (one.at === held.at && one.seq < held.seq) ? one : held;

/**
 * A range's numbers, and the minute-buckets of whatever part of it was inside the day.
 *
 * Both at once, off one pass over the logs, because they are the same logs: a trade near
 * the head belongs to the cumulative total *and* to the minute it happened in. Scanning
 * the day separately would be ten more chunk requests every twenty seconds against an
 * endpoint this codebase has measured dropping nineteen of forty.
 *
 * `day` is empty for a range entirely below the window, which is nearly all of them, and
 * empty on a chain with no {@link Grain}.
 *
 * `price` is the per-token track behind the market list's 24-hour change, and it rides on
 * the same pass for the same reason — a `Trade` states the reserves it left behind, so the
 * price at every point in the day is already in the logs this was fetching. Keyed by
 * lowercased token address, and only for the launches the list can actually show. See
 * {@link Marks}.
 */
type Counted = { total: Part; day: Map<bigint, Part>; price: Map<string, Marks> };

const none = (): Counted => ({
  total: ZERO,
  day: new Map(),
  price: new Map(),
});

/**
 * `from` into `into`, mutating the accumulator.
 *
 * Mutating on purpose, and safe because every accumulator here is built inside the read
 * that uses it — the store's own map is rebuilt at commit time rather than added to. A
 * fresh Map per merge would copy up to 1,440 entries per chunk over 43 chunks for
 * nothing.
 */
function absorb(into: Counted, from: Counted): Counted {
  into.total = plus(into.total, from.total);
  for (const [at, part] of from.day) {
    const held = into.day.get(at);
    into.day.set(at, held ? plus(held, part) : part);
  }
  // Prices are the later of the two rather than a sum, which is the whole reason a `Tick`
  // carries its position: the two sides of this merge are arbitrary ranges of history in
  // no particular order.
  for (const [token, marks] of from.price) {
    const held = into.price.get(token);
    if (!held) {
      into.price.set(token, marks);
      continue;
    }
    if (marks.before) held.before = later(held.before, marks.before);
    for (const [at, tick] of marks.at) held.at.set(at, later(held.at.get(at), tick));
  }
  return into;
}

/**
 * An accumulator that files each event twice: into the range's total, and into the minute
 * it happened in when it happened inside the window.
 *
 * Shared by both venues because the filing is the part worth having once. A trade counted
 * into the total but not its bucket is a day figure quietly missing a venue, and that is
 * a bug nothing would show — both numbers would still look like numbers.
 *
 * `mark` is the price half, and it is separate from `put` because the two are not the same
 * event: every log that moves ETH is volume, and every log that leaves a price behind is a
 * price, and a graduated token's `Sync` is the second without being the first. Callers
 * resolve which token a log belongs to and whether the market list is showing it; this
 * decides which side of the day floor the price falls on and which bucket keeps it.
 */
function counter(grain: Grain | undefined) {
  const out = none();
  const put = (block: bigint, one: Part) => {
    out.total = plus(out.total, one);
    if (!grain || block < grain.from) return;
    const at = block / grain.size;
    const held = out.day.get(at);
    out.day.set(at, held ? plus(held, one) : one);
  };
  const mark = (token: string, tick: Tick) => {
    // A zero is not a price. `spotPriceE18` returns one for an empty token reserve, which
    // is a pair mid-creation rather than a token that was briefly worthless, and dividing
    // a change by it would be a percentage of nothing.
    if (!grain || tick.priceE18 <= 0n) return;
    let marks = out.price.get(token);
    if (!marks) {
      marks = { at: new Map() };
      out.price.set(token, marks);
    }
    if (tick.at < grain.from) marks.before = later(marks.before, tick);
    else {
      const at = tick.at / grain.priceSize;
      marks.at.set(at, later(marks.at.get(at), tick));
    }
  };
  return { out, put, mark };
}

/** The four legs, given a range's logs and the two numbers no log carries. */
function feesOf(p: Part, launch: bigint, cutOn: boolean): Fees {
  const pool = cutOn ? (p.poolEth * POOL_CUT_BPS) / BPS : 0n;
  return {
    launch,
    curve: p.curveFees,
    graduation: p.gradFees,
    pool,
    total: launch + p.curveFees + p.gradFees + pool,
  };
}

/** An indexed window in the shape {@link feesOf} takes. */
const partOf = (c: IndexedWindow): Part => ({
  eth: c.eth,
  poolEth: c.poolEth,
  trades: c.trades,
  curveFees: c.curveFees,
  gradFees: c.gradFees,
  // Zero because there is nothing to count. The scan tallies `TokenCreated` so it can
  // multiply by today's `creationFee` at the end; the indexer holds what each launch
  // actually paid, at the fee in force in its own block, so the leg arrives summed and is
  // passed to `feesOf` directly. See `IndexedWindow.creationFees`.
  launches: 0,
});

/**
 * An indexed answer, with this route's own fee policy applied to it.
 *
 * Everything here is a rename except the three fields the indexer cannot supply and this
 * route decides:
 *
 * `fees.pool` is derived from `poolEth` exactly as it is on the scan path, by the same
 * `feesOf` — whether the DEX fee switch is on is pair state on the chain and not a row in
 * any table, so it stays a contract read either way. See {@link POOL_CUT_BPS}.
 *
 * `allTime` is true, and that is the point of gating the whole path on `/ready`: an
 * indexer that has finished its backfill has every block from the launchpad's deployment
 * onwards, which is the exact claim this flag makes. A partial one would make the same
 * claim about a smaller number, which is why `lib/indexer.ts` refuses to answer until it
 * can back it.
 *
 * `day` is never null here, where the scan's is null on a chain that declares no
 * `blockTime`. The scan needs one to turn 86,400 seconds into a block range; a `WHERE
 * timestamp >= …` needs nothing but the clock.
 */
function volumeOf(indexed: IndexedVolume, cutOn: boolean): Volume {
  const { all, day } = indexed;
  const span = indexed.head - indexed.startBlock + 1n;
  return {
    eth: all.eth,
    trades: all.trades,
    fees: feesOf(partOf(all), all.creationFees, cutOn),
    // The deploy block to the indexed head. Not rendered while `allTime` holds — see
    // `MarketStats` — but it is the range these figures cover, so it says so.
    blocks: span > 0n ? span : 0n,
    allTime: true,
    day: {
      eth: day.eth,
      trades: day.trades,
      fees: feesOf(partOf(day), day.creationFees, cutOn),
      seconds: day.seconds,
      opens: day.opens,
    },
  };
}

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
 * `day` is the minute-buckets of the settled range, and only the settled range: the tail
 * is re-read every time and its buckets are rebuilt with it, so keeping them would double
 * five minutes of trading. Pruned at commit time rather than as buckets expire — see the
 * rebuild in `readVolume`.
 *
 * `price` is the per-token price track, kept and pruned on exactly the same terms, and for
 * one reason beyond symmetry: it is the half of this store that cannot be rebuilt from a
 * short read. Volume is a sum, so a cold instance answering with recent trading is simply
 * a smaller true number; a price a day old has to have been *seen* a day ago, so what
 * makes the change over a full day available at all is that the day is behind us in here.
 *
 * Keyed by launchpad address as well as chain. A total accumulated from one
 * deployment's floor cannot be extended onto another's, and the two would otherwise
 * share an entry and quietly add up to neither.
 */
type Store = {
  total: Part;
  day: Map<bigint, Part>;
  price: Map<string, Marks>;
  lo: bigint;
  hi: bigint;
  pairs: Set<string>;
  owed: Owed[];
};

const stores = new Map<string, Store>();

/**
 * What the launchpad did over one range: the ETH that moved on the curves, the launches
 * it charged for, and the two fees a log will admit to.
 *
 * All three events on one request. `eth_getLogs` accepts a list of topics for position
 * zero, which viem spells `events: [...]`, so adding graduations and launches to a scan
 * that was already reading trades costs nothing at all — no extra round trip, no extra
 * chunk, the same 43 requests over Ink Sepolia's history. That mattered enough to be worth
 * saying: the obvious shape, a scan per event, would have been three requests per chunk
 * for two events that fire once in a token's lifetime.
 *
 * `TokenCreated` is counted rather than valued, and only the window needs it — the
 * all-time launch leg comes off the contract's own `tokenCount`, which is both exact and
 * complete on the first read. A counter cannot be windowed, so inside the day the launches
 * have to be counted from logs like everything else.
 *
 * `feeAmount` is what the contract actually took on that trade, so the total is a sum of
 * what happened rather than volume multiplied by today's rate. Those stop being the same
 * number the moment `tradeFeeBps` is changed, and only one of them is revenue.
 *
 * `trades` counts trades. A graduation is a fee and a launch is neither, and folding
 * either into the count would put a number under "Volume" that no longer matches the rows
 * anybody can scroll through.
 *
 * A `Trade` also states the reserves it left the curve at, which is where the price half
 * of this comes from — no extra event, no extra request, and exact rather than inferred
 * from the amounts that moved.
 */
const launchpadIn =
  (
    client: LogScanClient,
    launchpad: Address,
    grain: Grain | undefined,
    watch: ReadonlySet<string>,
  ) =>
  async (r: Range): Promise<Counted> => {
    const logs = await client.getLogs({
      address: launchpad,
      // No `args` filter: this is every token's trades, not one token's.
      events: [TRADE_EVENT, GRADUATED_EVENT, TOKEN_CREATED_EVENT],
      fromBlock: r.from,
      toBlock: r.to,
    });
    const { out, put, mark } = counter(grain);
    for (const log of logs) {
      const at = log.blockNumber ?? 0n;
      if (log.eventName === "TokenCreated") {
        put(at, { ...ZERO, launches: 1 });
        continue;
      }
      if (log.eventName === "Graduated") {
        const fee = (log.args as GraduatedArgs).protocolFee ?? 0n;
        put(at, { ...ZERO, gradFees: fee });
        continue;
      }
      const a = log.args as TradeArgs;
      put(at, {
        ...ZERO,
        eth: a.ethAmount ?? 0n,
        curveFees: a.feeAmount ?? 0n,
        trades: 1,
      });
      // The price this trade left the curve at, which the event carries outright — see
      // `TradeArgs`. Only for a token the market list is showing: the scan covers every
      // launch there has ever been, and a price track for all of them would be memory
      // spent on rows nothing can render.
      const token = a.token?.toLowerCase();
      if (token && watch.has(token)) {
        mark(token, {
          at,
          seq: log.logIndex ?? 0,
          priceE18: spotPriceE18(a.ethReserve ?? 0n, a.tokenReserve ?? 0n),
        });
      }
    }
    return out;
  };

/**
 * The pools' ETH over one range, for a set of pairs at once, and the prices they left.
 *
 * `eth_getLogs` takes a list of addresses, which is what keeps this one request per
 * range rather than one per pair per range — the difference between 43 requests and
 * 43 times however many tokens have graduated.
 *
 * `Sync` rides on the same request as `Swap`, through the same topic-zero list the
 * launchpad scan uses, because a swap says what moved and not what it left behind: a
 * graduated token is priced off its pair, and the only place a pair states its reserves
 * is the `Sync` it emits from the same `_update`. So the pool half of a price track costs
 * no request either — it costs returned logs, which is the one thing worth watching here.
 * A chain that caps matched logs per `eth_getLogs` rather than blocks per range (see
 * `logChunk` in lib/chains.ts) has less headroom in a chunk now than it did.
 *
 * `tokenOf` is pre-filtered to the launches the market list shows, so a pair missing from
 * it is either unwatched or unknown and its prices are simply not tracked. Its volume
 * still is: `wethIsToken0` is the map that decides whether a swap is counted at all.
 */
const poolIn =
  (
    client: LogScanClient,
    pairs: readonly Address[],
    wethIsToken0: Map<string, boolean>,
    tokenOf: Map<string, string>,
    grain: Grain | undefined,
  ) =>
  async (r: Range): Promise<Counted> => {
    if (pairs.length === 0) return none();
    const logs = await client.getLogs({
      address: pairs as Address[],
      events: [SWAP_EVENT, SYNC_EVENT],
      fromBlock: r.from,
      toBlock: r.to,
    });
    const { out, put, mark } = counter(grain);
    for (const log of logs) {
      const pair = log.address.toLowerCase();
      const side = wethIsToken0.get(pair);
      if (side === undefined) continue;
      if (log.eventName === "Sync") {
        const token = tokenOf.get(pair);
        if (!token) continue;
        const s = log.args as SyncArgs;
        mark(token, {
          at: log.blockNumber ?? 0n,
          seq: log.logIndex ?? 0,
          priceE18: spotPriceE18(
            (side ? s.reserve0 : s.reserve1) ?? 0n,
            (side ? s.reserve1 : s.reserve0) ?? 0n,
          ),
        });
        continue;
      }
      const eth = swapEth(log.args as SwapArgs, side);
      // No fee here, and none is missing: a swap's 0.3% stays in the pool, which makes it
      // the LPs' income — the same line `Trade.fee` draws in lib/scans.ts. The protocol's
      // sixth of it is not paid per swap and cannot be summed from these logs, so it is
      // derived from `poolEth` once per window, at the end. See {@link POOL_CUT_BPS}.
      put(log.blockNumber ?? 0n, { ...ZERO, eth, poolEth: eth, trades: 1 });
    }
    return out;
  };

async function readVolume(chain: Chain, launchpad: Address): Promise<Volume> {
  const deadline = Date.now() + REACH_MS;
  const reads = serverClient(chain);
  const scan = logClient(chain);
  const { chunk, reorgTail } = scanPolicy(chain.id);

  // Round 1: the head, with the DEX resolution riding along — created before the
  // await so its `router()` joins the same tick, and free on a memo hit.
  const dex = dexFor(reads, chain.id, launchpad);

  // Whether the DEX fee switch is even on. Chained off `dex` because it needs the
  // factory address, and awaited at the very end so it overlaps the whole log scan.
  const cutRead = dex.then((d) => feeToFor(reads, chain.id, d.factory));
  void cutRead.catch(() => {});

  // The indexer, if one is serving this chain and has finished its backfill — in which
  // case the rest of this function does not run and neither do its twenty-odd log
  // requests. Checked here, after the two reads above are in flight and before anything
  // else is issued: the fee switch is the one fact the indexer cannot supply, so that
  // read is shared, and everything below it is scan-only work worth not starting.
  //
  // `cutRead` is awaited on both paths and throws on both, which is `feeToFor`'s stated
  // policy — a revenue total that guessed the gate would be inventing a leg or dropping
  // one. `cached` covers the outage with the previous answer.
  const indexed = await indexedVolume(chain.id, launchpad, DAY_S);
  if (indexed) return volumeOf(indexed, Boolean(await cutRead));

  // The launch leg of revenue, and the only one that is not a log. `creationFee` is
  // charged per launch and forwarded on the spot, so what the protocol has taken is
  // every launch there has ever been times the fee — `tokenCount` being the contract's
  // own counter, which makes this leg exact and complete on the first read, while the
  // log legs are still reaching backwards.
  //
  // The one way it can be wrong: the fee is settable, and a change would re-value every
  // launch that happened before it at the new price. It has never been changed on either
  // deployment. If it ever is, `CreationFeeUpdated(oldFee, newFee)` is the timeline that
  // would attribute each launch to the fee in force at its block — which is what the
  // indexer path above already does, because it sums rows rather than multiplying a
  // counter.
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

  const latest = await reads.getBlockNumber();

  // Where the rolling day begins on this chain, in this chain's blocks. Undefined only on
  // a chain that declares no block time, and the whole day figure goes with it.
  const grain = grainOf(chain, latest);

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
  const { value: market } = await cached(`volume-pairs:${chain.id}`, TOKENS_MEMO_MS, async () => {
    const { tokens } = await allTokens(reads, launchpad);
    const resolved = await dex;
    const live = await pairsFor(reads, resolved, tokens);
    // Reserves come along unused. `quotesFor` is the one place that decides which leg
    // of a `Swap` is ETH, and a second copy of that decision is exactly how a total
    // comes to count sells twice and buys not at all. Its keys come along used, though:
    // they are the lowercased token each pair is the market for, which is what turns a
    // `Sync` from an address into a launch the list can put a price change beside.
    return { tokens, quotes: await quotesFor(reads, resolved.weth, live) };
  });

  const pairs = Object.values(market.quotes);
  const addresses = pairs.map((p) => p.pair);
  const wethIsToken0 = new Map(
    pairs.map((p) => [p.pair.toLowerCase(), p.wethIsToken0] as const),
  );

  // The launches a price track is kept for: the newest page of them, which is the page
  // the market list shows and therefore the only one that can render a change. `allTokens`
  // returns them oldest first, so the newest are the tail of it. Lowercased keys and the
  // address as the launchpad spelled it, since the answer goes on the wire.
  const watch = new Map(
    market.tokens.slice(-MARKET_LIMIT).map((t) => [t.toLowerCase(), t] as const),
  );
  const tokenOf = new Map(
    Object.entries(market.quotes)
      .filter(([token]) => watch.has(token))
      .map(([token, q]) => [q.pair.toLowerCase(), token] as const),
  );

  const floor = await floorRead;
  const from = floor.block;

  // Everything below this is final and worth keeping; everything above it is the
  // sequencer's to change its mind about and is re-read every time.
  const settledTo = latest > from + reorgTail ? latest - reorgTail : from - 1n;

  const key = `${chain.id}:${launchpad.toLowerCase()}`;
  const found = stores.get(key);
  // An empty range just below the tail: nothing counted, everything still to reach.
  // Also where a record that cannot be reconciled with this floor starts again.
  const held: Store =
    found && found.lo >= from && found.lo <= settledTo + 1n
      ? found
      : {
          total: ZERO,
          day: new Map<bigint, Part>(),
          price: new Map<string, Marks>(),
          lo: settledTo + 1n,
          hi: settledTo,
          pairs: new Set<string>(),
          owed: [],
        };

  const padRead = launchpadIn(scan, launchpad, grain, new Set(watch.keys()));
  const poolRead = poolIn(scan, addresses, wethIsToken0, tokenOf, grain);
  /** One chunk, both venues. */
  const both = (r: Range) =>
    Promise.all([padRead(r), poolRead(r)]).then(([c, p]) => absorb(c, p));

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
    ...ranges(held.hi + 1n, settledTo, chunk).map((range) => ({ settled: true, range })),
    ...ranges(settledTo + 1n, latest, chunk).map((range) => ({ settled: false, range })),
  ];
  const parts = await lanes(jobs, (j) => both(j.range), WAVE);

  // Backward, until the clock says stop: newest chunks first, so the range counted
  // stays contiguous with the head and a partial total is always recent trading rather
  // than a prefix missing today's. The deadline goes in rather than being polled here,
  // so a wave that hangs is abandoned instead of overrunning the whole read.
  let lo = held.lo;
  const back = none();
  let ranOut = false;
  const behind = ranges(from, held.lo - 1n, chunk);
  if (behind.length) {
    const walk = await newestChunksUntil(behind, both, () => false, WAVE, deadline);
    for (const part of walk.results) absorb(back, part);
    lo = walk.reached;
    ranOut = walk.ranOut;
  }

  // The graduation queue, with whatever time is left. Pool logs only: a new pair
  // changes nothing about what the curve did.
  //
  // A queue that has not drained leaves the day figure a shade low as well as the total,
  // and only in one unlikely case: a pair created *before* the window whose swaps inside
  // it are still owed. A pair created inside the window has no earlier swaps to owe, so
  // the ordinary graduation — the one that happens while somebody is watching — is
  // already whole.
  const nextOwed: Owed[] = [];
  for (const o of owed) {
    const chunks = ranges(o.from, o.to, chunk);
    if (!chunks.length) continue;
    if (Date.now() > deadline) {
      nextOwed.push(o);
      continue;
    }
    const late = poolIn(scan, o.pairs, wethIsToken0, tokenOf, grain);
    const { results, reached } = await newestChunksUntil(
      chunks,
      late,
      () => false,
      WAVE,
      deadline,
    );
    for (const part of results) absorb(back, part);
    if (reached - 1n >= o.from) nextOwed.push({ ...o, to: reached - 1n });
  }

  /* The settled side and the tail, built into fresh accumulators rather than onto
   * `held` — see the note above. */
  const settled = none();
  settled.total = held.total;
  // Buckets are pruned here rather than as they expire: this is the one place per read
  // that rebuilds the map, and a bucket's key is the only thing that says how old it is.
  // The bucket holding `grain.from` is kept whole, which is where the window's minute of
  // slack comes from.
  for (const [at, part] of held.day) {
    if (grain && at >= grain.from / grain.size) settled.day.set(at, part);
  }
  // The price track, pruned on the same pass and by the same rule, with two differences.
  //
  // The floor is applied to the price's own block rather than to its bucket, so nothing
  // here widens the window: a five-minute bucket is a bound on how many prices are kept,
  // never on which of them counts as inside the day.
  //
  // And what falls out is not dropped, it is remembered as `before` — the price this
  // launch was last at when the day began, which is precisely the number a change is
  // measured from. See {@link Marks}.
  if (grain) {
    for (const [token, marks] of held.price) {
      // A launch that has aged off the market list. Nothing can render its change, and a
      // store that only ever grew would hold a price track for every launch there has
      // ever been.
      if (!watch.has(token)) continue;
      const kept: Marks = { before: marks.before, at: new Map() };
      for (const [at, tick] of marks.at) {
        if (tick.at >= grain.from) kept.at.set(at, tick);
        else kept.before = later(kept.before, tick);
      }
      settled.price.set(token, kept);
    }
  }
  absorb(settled, back);

  const tail = none();
  parts.forEach((part, i) => absorb(jobs[i].settled ? settled : tail, part));

  if (lo > from || nextOwed.length) {
    console.log(
      `[volume] chain ${chain.id}: counted ${lo}–${settledTo} of ${from}, ` +
        `${behind.length - ranges(from, lo - 1n, chunk).length}/${behind.length} chunks this read` +
        `${ranOut ? " (out of time)" : ""}, ${nextOwed.length} pairs behind`,
    );
  }

  stores.set(key, {
    total: settled.total,
    day: settled.day,
    price: settled.price,
    lo,
    hi: settledTo,
    pairs: new Set([...held.pairs, ...addresses.map((a) => a.toLowerCase())]),
    owed: nextOwed,
  });

  const all = plus(settled.total, tail.total);
  // The window, summed off the buckets both sides kept. Summing values needs no key
  // merge: a bucket straddling `settledTo` has a settled half in one map and an
  // unsettled half in the other, and the day wants both.
  const inDay = grain
    ? [...settled.day.values(), ...tail.day.values()].reduce(plus, ZERO)
    : ZERO;

  // The two legs no log carries. `launch` is complete however far the scan has reached,
  // because it comes off a counter rather than a range; `pool` is only ever as complete
  // as the pool volume it is a share of, and is zero outright while the fee switch is
  // off — see `feeToFor`.
  const launch = tokenCount * creationFee;
  const cutOn = Boolean(await cutRead);

  return {
    eth: all.eth,
    trades: all.trades,
    fees: feesOf(all, launch, cutOn),
    blocks: latest - lo + 1n,
    // Every trade the market has ever made — which needs the scan to have reached the
    // floor, every late pair to have caught up, and the floor itself to be the real
    // deployment block rather than a fallback. See `Floor` in lib/chunks.ts.
    allTime: lo <= from && nextOwed.length === 0 && floor.exact,
    day: grain
      ? {
          eth: inDay.eth,
          trades: inDay.trades,
          // Launches counted from logs and valued at today's fee, where the all-time leg
          // above is the contract's counter at the same fee. See `Day` in lib/scans.ts.
          fees: feesOf(inDay, BigInt(inDay.launches) * creationFee, cutOn),
          // What the buckets actually span: a full day once the scan has one behind it,
          // and the reach so far while it is still working backwards.
          seconds: Math.min(
            DAY_S,
            Number(latest - (lo > grain.from ? lo : grain.from) + 1n) * grain.blockS,
          ),
          opens: openings(watch, settled.price, tail.price),
        }
      : null,
  };
}

/**
 * What each watched launch cost when the window opened.
 *
 * The settled side is asked first and the tail only if it has nothing, because the two
 * cover disjoint ranges and the settled one is strictly the older: the tail is the last few
 * minutes of the chain, so a launch with any settled price at all opened before its earliest
 * unsettled one. Nothing has to be merged to establish that.
 *
 * A launch with no price on either side is left out rather than sent as a zero. It has not
 * traded within the scan's reach, and the honest answer to "how much has it moved" is that
 * there is nothing to say — which the list renders as nothing, not as flat.
 */
function openings(
  watch: ReadonlyMap<string, Address>,
  settled: ReadonlyMap<string, Marks>,
  tail: ReadonlyMap<string, Marks>,
): Opens {
  const out: Opens = {};
  for (const token of watch.keys()) {
    const open = openOf(settled.get(token)) ?? openOf(tail.get(token));
    if (open) out[token] = open.priceE18;
  }
  return out;
}

/**
 * A launch's opening price: the last one before the window when there is one, and the first
 * one inside it otherwise.
 *
 * The fallback is the case of a launch younger than the window, where there is no earlier
 * price because there was no token — so its change is measured from its first trade, which
 * is what "since launch" means on a token that launched this morning.
 */
function openOf(marks: Marks | undefined): Tick | undefined {
  if (!marks) return undefined;
  if (marks.before) return marks.before;
  let first: Tick | undefined;
  for (const tick of marks.at.values()) first = earlier(first, tick);
  return first;
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
