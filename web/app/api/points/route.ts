import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { isAddress, zeroAddress } from "viem";
import { launchpadAbi, pointsAbi, routerAbi } from "@/lib/abis";
import { pruneVerdicts, verifyActivity } from "@/lib/activity";
import { ink, inkSepolia } from "@/lib/chains";
import {
  deployBlock,
  lanes,
  newestChunksUntil,
  ranges,
  scanPolicy,
  type Range,
} from "@/lib/chunks";
import { launchpadFor } from "@/lib/contracts";
import {
  GRANTED_EVENT,
  REDEEMED_EVENT,
  REGISTERED_EVENT,
  SWAP_EVENT,
  TOKEN_CREATED_EVENT,
  TRADE_EVENT,
  type GrantArgs,
  type RegisteredArgs,
  type SwapArgs,
  type TokenCreatedArgs,
  type TradeArgs,
} from "@/lib/events";
import {
  pointsFor,
  pointsFrom,
  pointsFromBlock,
  RATES_FALLBACK,
  type PointCounts,
  type Rates,
} from "@/lib/points";
import { allPairs } from "@/lib/server-dex";
import {
  cached,
  cacheHeaders,
  chainFrom,
  logClient,
  serverClient,
  type LogScanClient,
  type ServerClient,
} from "@/lib/server-rpc";
import { waitlistFor } from "@/lib/waitlist-address";

/**
 * uwPoints for one address, and where that address ranks.
 *
 * A server route rather than a browser read, for the reasons lib/server-rpc.ts
 * argues at length: counting a wallet's activity is an `eth_getLogs` walk over the
 * chain's whole history, which is far too much to run per tab and is identical for
 * everybody looking at the same chain in the same minute. Read once, cache at the
 * edge, let every visitor read the answer.
 *
 * **The board is one scan, not one scan per wallet.** This is the whole shape of the
 * file and the thing worth understanding before changing it. The first version asked
 * the chain "what did *this* address do" and then ran that question once per
 * registrant, so a board of N wallets cost N walks over the same history — 5N chunked
 * log scans, all issued at once by a `Promise.all` over the registrant list. On Ink
 * Sepolia's 400k blocks that is some 570 requests *per wallet*, which is not a slow
 * request, it is a request that cannot finish: the endpoint starts dropping calls
 * under the fan-out and the function hits its ceiling long before the arithmetic.
 *
 * The events are all indexed on the address, so the per-wallet filter reads naturally
 * — and that is the trap. `Registered`, `TokenCreated`, `Trade` and `Swap` are the
 * *same four log streams* for everybody. So they are read once, unfiltered, and
 * bucketed by address here. One walk of history yields every wallet's counts at once,
 * the cost stops depending on how many people have registered, and a rank becomes
 * free rather than being the expensive thing in the file.
 *
 * Grants are counted the same way and for the same reason. `granted[who]` is the one
 * term that is *read* rather than derived, so a board of N wallets wanted N calls —
 * which is the same mistake one layer down. It is cumulative and never decremented, so
 * `Redeemed` and `Granted` summed over history give the mapping exactly (see
 * lib/events.ts), and the board costs no per-wallet reads at all. The one address that
 * still gets a direct `granted` call is the one being asked about, whose own balance
 * must be exact even mid-backfill.
 *
 * The one thing that genuinely cannot be counted from a log is the activity bar on a
 * referral — a nonce and a lending position, on two other chains. That is bounded
 * instead: verdicts are remembered, a read verifies as many unverified wallets as its
 * clock allows, and `partial` stays true until none are left.
 *
 * Affording the walk at all means never doing it twice and never doing it all at
 * once, which is the pattern /api/volume established: logs below the reorg tail
 * cannot change, so the counts over them are kept and extended — each read picks up
 * the new blocks at the head and then spends {@link REACH_MS} reaching further back
 * than the last one. A cold instance answers in seconds with recent history and has
 * all of it a few reads later, instead of making the first visitor wait for a sweep
 * the platform would kill. `partial` is true until it converges.
 *
 * **What this route is not.** It is not authoritative and must not be described as
 * such. It is arithmetic over public logs, and anyone can rerun it — that is the
 * point of deriving balances rather than storing them (see UnderwaterPoints.sol).
 * When uwPoints become $WATER the claim will go through a committed snapshot, the
 * way the plates allowlist already does, not through this number.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * Cache windows.
 *
 * The index is the expensive thing and the one every answer is derived from, so its
 * window is what actually bounds origin work: at most one walk per instance per
 * window no matter how many addresses ask. Thirty seconds rather than the ten minutes
 * the old board used, because the window is now also the backfill's step — a longer
 * one would mean a cold instance took an hour to reach the floor instead of a few
 * minutes, and the bounded {@link REACH_MS} already makes each step cheap.
 *
 * There is deliberately no per-address memo any more. It bought nothing once the
 * index existed — scoring one wallet out of it is a map lookup and a sort — and it
 * keyed the module-scope cache by address, which is an entry per wallet ever queried
 * and the one unbounded thing in this file.
 */
const INDEX_MEMO_MS = 30_000;
const RATES_MEMO_MS = 30_000;
const PAIRS_MEMO_MS = 10 * 60_000;
const EDGE_S = 30;
const SWR_S = 300;

/**
 * How long a wallet's activity verdict is reused, and how many are checked per read.
 *
 * The memo itself is lib/activity.ts' — worth remembering across index rebuilds rather
 * than inside one, since the bar is three reads across two chains and it is asked once
 * per *referred* wallet. What is set here is the ceiling one read will spend on it, which
 * this route needs because it verifies a whole chain's referral set at once.
 *
 * Bounded rather than skipped because it converges the same way the backfill does:
 * verdicts are kept, so each read gets through another batch and `partial` clears when
 * none are left.
 */
const VERIFY_MAX = 120;

/**
 * Wallets checked concurrently. Each is three reads, so this is twelve — which the
 * batching transport folds into about two requests per chain, not twelve.
 */
const VERIFY_LANES = 4;

/**
 * Wall clock one read will spend reaching backwards, in milliseconds.
 *
 * Same bound and the same reasoning as /api/volume, including why it is a clock and
 * not a chunk count: the same fifteen chunks measured 4 seconds on a good minute and
 * 13 on a bad one, and only a clock bounds the *request*, which is the thing with a
 * platform ceiling over it. `export const maxDuration` is not the way out — on Next
 * 15.5.23 it drags the Pages Router shims through Turbopack and `next build` dies on
 * a runtime chunk that is never emitted, the same trap `revalidate` set.
 *
 * Enforced per chunk rather than merely consulted between waves, because a request
 * left to its own timeout and retries can outlast the whole budget several times over
 * — see `newestChunksUntil` in lib/chunks.ts. There is always one wave, so every read
 * makes progress and a cold instance converges rather than stalling.
 */
const REACH_MS = 7_000;

/**
 * Chunks in flight per wave. Each chunk is four log requests: the waitlist's
 * `Registered`, the launchpad's two events in one request, one `Swap` request covering
 * every pair at once, and the points contract's two events in one request.
 *
 * Two rather than the `LANES` default of six, because the unit here is four requests
 * and not one: this is eight in flight, which is the neighbourhood the rest of the
 * codebase settled on against an endpoint measured dropping nineteen of forty
 * concurrent calls. Pairing the events of a contract into a single `eth_getLogs` — a
 * topic filter with two hashes in it — is what keeps that number at four as the number
 * of things worth counting grows.
 */
const WAVE = 2;

/**
 * Distinct addresses above which ranks stop being offered.
 *
 * The scan no longer cares how many wallets there are — it reads the same four
 * streams either way, and grants come out of them too — so nothing about building the
 * index is bounded by this. It bounds the sort and the response's `rankOf`. Past it the
 * honest response is a balance with no rank rather than a rank nobody could check; the
 * card handles a missing rank and cannot handle a wrong one.
 */
const BOARD_LIMIT = 20_000;

/**
 * What one address did over some range of blocks, before rates are applied.
 *
 * `referred` is a set of addresses rather than a count because the same registration
 * must not be counted twice when two ranges overlap — the unsettled tail is re-read
 * on every request, so overlap is the normal case and not an edge one.
 *
 * `position` is the waitlist's own arrival index, carried in the `Registered` log. It
 * is the tiebreak for equal totals, and it comes from the event precisely so the sort
 * does not depend on the order the scan happened to read history in: the backfill
 * walks *backwards*, so insertion order is not arrival order.
 */
type Tally = {
  registered: boolean;
  position: bigint | null;
  referred: Set<string>;
  creates: number;
  trades: number;
  /// Coupons redeemed plus hand grants, summed from the two points-contract logs.
  /// Cumulative on chain and never decremented, so a sum over history is the mapping.
  granted: bigint;
};

/** Every address's tally over a range. Keys are lowercased addresses. */
type Ledger = Map<string, Tally>;

function blank(): Tally {
  return {
    registered: false,
    position: null,
    referred: new Set(),
    creates: 0,
    trades: 0,
    granted: 0n,
  };
}

function at(ledger: Ledger, who: string): Tally {
  let t = ledger.get(who);
  if (!t) {
    t = blank();
    ledger.set(who, t);
  }
  return t;
}

/** `from` added into `into`, which is mutated and returned. */
function fold(into: Ledger, from: Ledger): Ledger {
  for (const [who, t] of from) {
    const dst = at(into, who);
    if (t.registered) dst.registered = true;
    if (t.position !== null) dst.position = t.position;
    dst.creates += t.creates;
    dst.trades += t.trades;
    dst.granted += t.granted;
    for (const r of t.referred) dst.referred.add(r);
  }
  return into;
}

/**
 * A deep copy, sets included.
 *
 * So that nothing below the reads touches the held store until every request has
 * come back — the invariant /api/volume spells out. A half-applied update would mark
 * work done that never happened and lose those logs for the life of the instance.
 */
function clone(ledger: Ledger): Ledger {
  const out: Ledger = new Map();
  for (const [who, t] of ledger) {
    out.set(who, {
      registered: t.registered,
      position: t.position,
      referred: new Set(t.referred),
      creates: t.creates,
      trades: t.trades,
      granted: t.granted,
    });
  }
  return out;
}

/**
 * The waitlist's intake over one range: who registered, and who brought them.
 *
 * One log, two facts, which is why the points system needs no ledger of its own —
 * see `REGISTERED_EVENT` in lib/events.ts. No `args` filter: this is everybody's
 * registrations, which is the entire point of reading it here rather than per wallet.
 */
const intakeIn =
  (scan: LogScanClient, waitlist: Address) =>
  async (r: Range): Promise<Ledger> => {
    const logs = await scan.getLogs({
      address: waitlist,
      event: REGISTERED_EVENT,
      fromBlock: r.from,
      toBlock: r.to,
    });

    const out: Ledger = new Map();
    for (const log of logs) {
      const a = log.args as RegisteredArgs;
      if (!a.who) continue;
      const who = a.who.toLowerCase();
      const mine = at(out, who);
      mine.registered = true;
      if (a.position !== undefined) mine.position = a.position;

      const ref = a.referrer?.toLowerCase();
      // No referrer is the zero address, and a self-referral would pay a wallet for
      // its own registration on top of the registration itself.
      if (ref && ref !== zeroAddress && ref !== who) at(out, ref).referred.add(who);
    }
    return out;
  };

/**
 * The launchpad's two streams over one range: launches by creator, curve trades by
 * trader.
 *
 * One request with both topics rather than two requests, because the wave size is
 * counted in requests and this route now reads four contracts. `eth_getLogs` takes a
 * list of topics for position zero, which is what makes that free.
 */
const curveIn =
  (scan: LogScanClient, launchpad: Address) =>
  async (r: Range): Promise<Ledger> => {
    const logs = await scan.getLogs({
      address: launchpad,
      events: [TOKEN_CREATED_EVENT, TRADE_EVENT],
      fromBlock: r.from,
      toBlock: r.to,
    });

    const out: Ledger = new Map();
    for (const log of logs) {
      if (log.eventName === "TokenCreated") {
        const who = (log.args as TokenCreatedArgs).creator?.toLowerCase();
        if (who) at(out, who).creates++;
      } else if (log.eventName === "Trade") {
        const who = (log.args as TradeArgs).trader?.toLowerCase();
        if (who) at(out, who).trades++;
      }
    }
    return out;
  };

/**
 * Pool swaps over one range, credited to the recipient — where there is one.
 *
 * `Swap.to` rather than the transaction sender, and it needs the caveat spelled out
 * because both of its edges look like bugs and only one of them is fixable here.
 *
 * The router sends intermediate hops to the *next pair* rather than to the trader (see
 * `_swap` in UnderwaterRouter.sol), and on a token→ETH sell it sends the WETH leg to
 * *itself* before unwrapping (lines 270, 290 and 356). So `to` is a contract we own on
 * some legs, and `sender` is the router on all of them — neither field names the trader
 * on a sell. `infra` is therefore excluded rather than bucketed: those addresses would
 * otherwise accumulate every hop and every sell on the chain and sit at the top of the
 * board, which is a far worse answer than a missing one.
 *
 * What that leaves is buys counted and router sells uncounted, which is exactly what
 * the per-wallet version of this filter did — a `Swap` filtered on `to = you` never
 * matched your sells either. Attributing them needs the transaction's sender, which is
 * a read per log over the whole history, so it is not something this walk can afford.
 * Curve trades are unaffected: `Trade.trader` is the trader.
 *
 * One request for every pair at once, which is what keeps this one request per range
 * rather than one per pair per range.
 */
const poolIn =
  (scan: LogScanClient, pairs: readonly Address[], infra: ReadonlySet<string>) =>
  async (r: Range): Promise<Ledger> => {
    const out: Ledger = new Map();
    if (pairs.length === 0) return out;

    const logs = await scan.getLogs({
      address: pairs as Address[],
      event: SWAP_EVENT,
      fromBlock: r.from,
      toBlock: r.to,
    });
    for (const log of logs) {
      const who = (log.args as SwapArgs).to?.toLowerCase();
      if (who && who !== zeroAddress && !infra.has(who)) at(out, who).trades++;
    }
    return out;
  };

/**
 * Grants over one range: coupons redeemed and points handed out.
 *
 * Both events in one request, and both summed into the same field, because both add to
 * the same `granted` mapping and the card shows them as one row. See the note on
 * `REDEEMED_EVENT` in lib/events.ts for why a sum of logs is the mapping rather than an
 * approximation of it.
 */
const grantsIn =
  (scan: LogScanClient, points: Address) =>
  async (r: Range): Promise<Ledger> => {
    const logs = await scan.getLogs({
      address: points,
      events: [REDEEMED_EVENT, GRANTED_EVENT],
      fromBlock: r.from,
      toBlock: r.to,
    });

    const out: Ledger = new Map();
    for (const log of logs) {
      const a = log.args as GrantArgs;
      if (!a.who || a.points === undefined) continue;
      at(out, a.who.toLowerCase()).granted += a.points;
    }
    return out;
  };

/**
 * Every pair the factory has made, and the addresses of ours that are not wallets.
 *
 * The second half is not incidental. `poolIn` credits `Swap.to`, and the router and the
 * pairs themselves appear there on hops and sells, so the board needs to know which
 * addresses are plumbing before it ranks anything.
 */
type Venues = { pairs: Address[]; infra: Set<string> };

async function allVenues(reads: ServerClient, launchpad: Address): Promise<Venues> {
  const infra = new Set<string>([launchpad.toLowerCase()]);
  try {
    const router = (await reads.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "router",
    })) as Address;
    infra.add(router.toLowerCase());

    const factory = (await reads.readContract({
      address: router,
      abi: routerAbi,
      functionName: "factory",
    })) as Address;
    infra.add(factory.toLowerCase());

    const pairs = await allPairs(reads, factory);
    for (const p of pairs) infra.add(p.toLowerCase());
    return { pairs, infra };
  } catch {
    return { pairs: [], infra };
  }
}

/**
 * The rate card, from the chain if the contract is deployed here.
 *
 * Falls back to `RATES_FALLBACK` rather than to zeroes, and reports which it used,
 * because a chain without the points contract should still show a coherent card
 * labelled as indicative — zeroes would read as "you have earned nothing", which is a
 * different and false statement.
 *
 * Read beside the index rather than inside it, so a `setRates` shows up on the next
 * request instead of waiting out the index's window. Nothing the index holds depends
 * on the rates: it counts actions, and rates only turn counts into a total and an
 * order.
 */
async function readRates(
  reads: ServerClient,
  points: Address | null,
): Promise<{ rates: Rates; onChain: boolean }> {
  if (!points) return { rates: RATES_FALLBACK, onChain: false };
  try {
    const [card] = (await reads.readContract({
      address: points,
      abi: pointsAbi,
      functionName: "rateCard",
    })) as [{ register: bigint; referral: bigint; create: bigint; swap: bigint }, bigint];

    return {
      rates: {
        register: card.register,
        referral: card.referral,
        create: card.create,
        swap: card.swap,
      },
      onChain: true,
    };
  } catch {
    return { rates: RATES_FALLBACK, onChain: false };
  }
}

/** Coupons and hand grants for one address. Zero when no contract is deployed. */
async function readGranted(
  reads: ServerClient,
  points: Address | null,
  who: Address,
): Promise<bigint> {
  if (!points) return 0n;
  try {
    return (await reads.readContract({
      address: points,
      abi: pointsAbi,
      functionName: "granted",
      args: [who],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * Every activity verdict this instance has reached lives in lib/activity.ts, shared with
 * /api/points/history so a row and a total cannot disagree about the same referral.
 * Pruned to the current referral set on every rebuild, which is this route's job because
 * it is the only caller that sees the whole set.
 */
/** Pairs that still owe their share of a range already counted without them. */
type Owed = { pairs: Address[]; from: bigint; to: bigint };

/**
 * The settled ledger and how much of history it covers, per deployment.
 *
 * `[lo, hi]` is the settled range counted, and it grows in both directions: `hi`
 * follows the head every read, `lo` reaches as far back as {@link REACH_MS} allows.
 * Counting from the head downwards keeps a partial answer useful — it is always the
 * most recent activity, never a prefix missing today's.
 *
 * `owed` is the awkward case, and it is the same one /api/volume documents. A token
 * graduating adds a pair address that was never scanned over `[lo, hi]`, so its
 * earlier swaps are not counted and never would be. The alternative to this queue is
 * throwing the pool counts away and rebuilding them, which would make balances
 * visibly *drop* the moment a token succeeded — the exact moment they should not.
 *
 * Keyed by the deployments as well as the chain: counts accumulated from one
 * waitlist's floor cannot be extended onto another's, and the two would otherwise
 * share an entry and add up to neither.
 */
type Store = {
  ledger: Ledger;
  lo: bigint;
  hi: bigint;
  pairs: Set<string>;
  owed: Owed[];
};

const stores = new Map<string, Store>();

/**
 * Everything every address has done, and how much of history that covers.
 *
 * `complete` is the honest form of "all-time": the walk reached the floor, no graduated
 * pair is behind, every referral has a verdict, and the floor is a real deployment block
 * rather than a fallback. Until all four hold, a total may be low and the card says so.
 */
type Index = {
  counts: Map<string, PointCounts>;
  positions: Map<string, bigint>;
  granted: Map<string, bigint>;
  complete: boolean;
  capped: boolean;
};

const EMPTY_INDEX: Index = {
  counts: new Map(),
  positions: new Map(),
  granted: new Map(),
  complete: true,
  capped: false,
};

async function readIndex(
  chain: Chain,
  where: { waitlist: Address | null; launchpad: Address | null; points: Address | null },
): Promise<Index> {
  const deadline = Date.now() + REACH_MS;
  const reads = serverClient(chain);
  const scan = logClient(chain);
  const { chunk, reorgTail } = scanPolicy(chain.id);
  const { waitlist, launchpad, points } = where;

  const latest = await reads.getBlockNumber();

  // Where history starts. Derived from the deployments rather than configured, for
  // the reason lib/chunks.ts gives: a FROM_BLOCK env var is one more thing that can
  // be left pointing at the previous deployment, and the failure that produces is a
  // history which silently starts late. All three searches are memoised forever — the
  // answer is a property of a deployment and cannot change — and they need nothing
  // but the head, so they go together.
  //
  // The points contract is in here because grants are counted from its logs now, and a
  // walk that started above its deployment would understate a balance rather than
  // merely start a count late. It is almost always the newest of the three, so this
  // costs nothing in practice.
  const [wlFloor, lpFloor, ptFloor] = await Promise.all([
    waitlist
      ? deployBlock(reads, chain.id, waitlist, latest).catch(() => null)
      : Promise.resolve(null),
    launchpad
      ? deployBlock(reads, chain.id, launchpad, latest).catch(() => null)
      : Promise.resolve(null),
    points
      ? deployBlock(reads, chain.id, points, latest).catch(() => null)
      : Promise.resolve(null),
  ]);

  const found = [wlFloor, lpFloor, ptFloor].filter(
    (f): f is NonNullable<typeof f> => !!f,
  );
  // None of the contracts has code here. Nothing to scan, and saying so beats walking a
  // million empty blocks to prove it.
  if (found.length === 0) return EMPTY_INDEX;

  const derived = found.reduce((lo, f) => (f.block < lo ? f.block : lo), found[0].block);
  // `POINTS_FROM_BLOCK_*` is still honoured, but only downwards. Starting earlier
  // than the earliest deployment is safe and merely slow; starting later drops
  // history silently, which is the one outcome worth refusing.
  const configured = pointsFromBlock(chain.id);
  const from = configured > 0n && configured < derived ? configured : derived;
  const exact = found.every((f) => f.exact) && from <= derived;

  // Every pair, memoised: this is the only part of the read that costs contract calls
  // rather than log requests, and a token graduating is picked up by the `owed` queue
  // whenever it is noticed rather than needing to be noticed promptly.
  const { value: venues } = await cached<Venues>(
    `points-pairs:${chain.id}`,
    PAIRS_MEMO_MS,
    () =>
      launchpad
        ? allVenues(reads, launchpad)
        : Promise.resolve({ pairs: [], infra: new Set<string>() }),
  );
  const { pairs, infra } = venues;

  // Everything below this is final and worth keeping; everything above it is the
  // sequencer's to change its mind about, and is re-read every time.
  const settledTo = latest > from + reorgTail ? latest - reorgTail : from - 1n;

  const key = `${chain.id}:${waitlist ?? "-"}:${launchpad ?? "-"}:${points ?? "-"}`.toLowerCase();
  const kept = stores.get(key);
  // An empty range just below the tail: nothing counted, everything still to reach.
  // Also where a record that cannot be reconciled with this floor starts again.
  const held: Store =
    kept && kept.lo >= from && kept.lo <= settledTo + 1n
      ? kept
      : { ledger: new Map(), lo: settledTo + 1n, hi: settledTo, pairs: new Set(), owed: [] };

  const intake = waitlist ? intakeIn(scan, waitlist) : null;
  const curve = launchpad ? curveIn(scan, launchpad) : null;
  const grants = points ? grantsIn(scan, points) : null;
  const pool = poolIn(scan, pairs, infra);
  const nothing = (): Promise<Ledger> => Promise.resolve(new Map());

  /** One chunk, every stream. */
  const everything = async (r: Range): Promise<Ledger> => {
    const parts = await Promise.all([
      intake ? intake(r) : nothing(),
      curve ? curve(r) : nothing(),
      grants ? grants(r) : nothing(),
      pool(r),
    ]);
    return parts.reduce<Ledger>((a, b) => fold(a, b), new Map());
  };

  /* Nothing below this point touches `held` — every request is issued and awaited
   * first, and only then is the store written. If a chunk fails the whole read
   * throws, `cached` serves the previous answer, and the store is exactly as it was.
   * See the same note in /api/volume. */

  // Pairs learned about since the last read owe their share of the counted range.
  const fresh = pairs.filter((p) => !held.pairs.has(p.toLowerCase()));
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
  const parts = await lanes(jobs, (j) => everything(j.range), WAVE);

  // Backward, until the clock says stop: newest chunks first, so the range counted
  // stays contiguous with the head and a partial answer is recent activity rather
  // than a prefix missing today's. The deadline goes in rather than being polled
  // here, so a wave that hangs is abandoned instead of overrunning the whole read.
  let lo = held.lo;
  let ranOut = false;
  const behind = ranges(from, held.lo - 1n, chunk);
  const back: Ledger = new Map();
  if (behind.length) {
    const walk = await newestChunksUntil(behind, everything, () => false, WAVE, deadline);
    for (const part of walk.results) fold(back, part);
    lo = walk.reached;
    ranOut = walk.ranOut;
  }

  // The graduation queue, with whatever time is left. Pool logs only: a new pair
  // changes nothing about what the curve or the waitlist did.
  const nextOwed: Owed[] = [];
  for (const o of owed) {
    const chunks = ranges(o.from, o.to, chunk);
    if (!chunks.length) continue;
    if (Date.now() > deadline) {
      nextOwed.push(o);
      continue;
    }
    const late = poolIn(scan, o.pairs, infra);
    const { results, reached } = await newestChunksUntil(
      chunks,
      late,
      () => false,
      WAVE,
      deadline,
    );
    for (const part of results) fold(back, part);
    if (reached - 1n >= o.from) nextOwed.push({ ...o, to: reached - 1n });
  }

  // Settled first, and that is what is kept. The tail is folded on top for the answer
  // only, so a log in a block the sequencer may still replace never becomes permanent.
  const settled = fold(clone(held.ledger), back);
  parts.forEach((part, i) => {
    if (jobs[i].settled) fold(settled, part);
  });

  const live = clone(settled);
  parts.forEach((part, i) => {
    if (!jobs[i].settled) fold(live, part);
  });

  if (lo > from || nextOwed.length) {
    console.log(
      `[points] chain ${chain.id}: counted ${lo}–${settledTo} of ${from}, ` +
        `${behind.length - ranges(from, lo - 1n, chunk).length}/${behind.length} chunks this read` +
        `${ranOut ? " (out of time)" : ""}, ${nextOwed.length} pairs behind`,
    );
  }

  stores.set(key, {
    ledger: settled,
    lo,
    hi: settledTo,
    pairs: new Set([...held.pairs, ...pairs.map((p) => p.toLowerCase())]),
    owed: nextOwed,
  });

  // One verdict per referred wallet, not one per referrer scoring it: a wallet has
  // exactly one referrer, so these sets are disjoint and the union is simply every
  // referral on the chain. Bounded and remembered — see VERIFY_MAX. This is the one
  // caller that sees the whole set, so it is the one that prunes the memo.
  const referred = new Set<string>();
  for (const t of live.values()) for (const r of t.referred) referred.add(r);
  const { pass: valid, behind: unasked } = await verifyActivity(
    [...referred],
    { mainnet: serverClient(ink), sepolia: serverClient(inkSepolia) },
    deadline,
    { max: VERIFY_MAX, lanes: VERIFY_LANES },
  );
  pruneVerdicts(referred);

  const counts = new Map<string, PointCounts>();
  const positions = new Map<string, bigint>();
  const granted = new Map<string, bigint>();
  for (const [who, t] of live) {
    // Again here, and not only where the swap was credited. `infra` comes from a list
    // that is ten minutes stale at worst, so a pair that graduated and was routed
    // through before we noticed it may already hold hops in the settled ledger — which
    // is permanent. Dropping it at scoring time means that heals itself the moment the
    // list refreshes, instead of leaving a pair sitting on the board.
    if (infra.has(who)) continue;
    counts.set(who, {
      registered: t.registered,
      referrals: t.referred.size,
      validReferrals: [...t.referred].filter((r) => valid.has(r)).length,
      creates: t.creates,
      trades: t.trades,
    });
    if (t.position !== null) positions.set(who, t.position);
    if (t.granted > 0n) granted.set(who, t.granted);
  }

  return {
    counts,
    positions,
    granted,
    // Every block that matters read, every late pair caught up, every referral asked,
    // and a floor that is a real deployment rather than a fallback. Any one of those
    // missing means some total here is low, which is what the card's footnote says.
    complete: lo <= from && nextOwed.length === 0 && unasked === 0 && exact,
    capped: counts.size > BOARD_LIMIT,
  };
}

/**
 * The board, from counts the index already holds.
 *
 * Sorted per request rather than cached with the index, because the order depends on
 * the rates and the rates are read separately — so a `setRates` re-prices and
 * re-ranks every balance immediately, which is what "a change re-prices every
 * balance" on the card has to mean. Sorting a map already in memory is free next to
 * the log walk that filled it.
 *
 * `self` is the one address whose grant is read from the contract rather than summed
 * from logs, and it is substituted here so a wallet's rank is computed from the same
 * number its card shows. Mid-backfill those can differ — the logs that credit it may be
 * below the block the walk has reached — and a card reading "12,000 points, rank 40th"
 * beside a 40th place scored on 2,000 is the kind of disagreement nobody can explain.
 *
 * Ties break on the waitlist's arrival index, the only ordering the chain gives us
 * for free, with unregistered addresses last.
 */
function board(
  index: Index,
  rates: Rates,
  self: { who: string; granted: bigint },
): string[] {
  if (index.capped) return [];

  const scored = [...index.counts].map(([who, counts]) => ({
    who,
    total: pointsFrom(
      counts,
      rates,
      who === self.who ? self.granted : (index.granted.get(who) ?? 0n),
    ).total,
    position: index.positions.get(who) ?? null,
  }));

  scored.sort((a, b) => {
    if (a.total !== b.total) return b.total > a.total ? 1 : -1;
    if (a.position === b.position) return 0;
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position < b.position ? -1 : 1;
  });

  return scored.map((s) => s.who);
}

const NO_COUNTS_FOR_ADDRESS: PointCounts = {
  registered: false,
  referrals: 0,
  validReferrals: 0,
  creates: 0,
  trades: 0,
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const chain = chainFrom(url);
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  const raw = url.searchParams.get("address");
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }
  const who = raw as Address;
  const key = who.toLowerCase();

  const reads = serverClient(chain);
  const waitlist = waitlistFor(chain.id);
  const launchpad = launchpadFor(chain.id);
  const points = pointsFor(chain.id);

  if (!waitlist && !launchpad) {
    return NextResponse.json({ error: "nothing deployed on this chain" }, { status: 404 });
  }

  try {
    // Three reads, none of which waits on another. The index is the shared expensive
    // one; the rate card and this wallet's grant are single calls that fold into one
    // multicall on the same client.
    const [index, card, granted] = await Promise.all([
      cached(`points-index:${chain.id}`, INDEX_MEMO_MS, () =>
        readIndex(chain, { waitlist, launchpad, points }),
      ).then((r) => r.value),
      cached(`points-rates:${chain.id}`, RATES_MEMO_MS, () =>
        readRates(reads, points),
      ).then((r) => r.value),
      readGranted(reads, points, who),
    ]);

    const counts = index.counts.get(key) ?? NO_COUNTS_FOR_ADDRESS;
    const breakdown = pointsFrom(counts, card.rates, granted);
    const order = board(index, card.rates, { who: key, granted });
    const rankAt = order.indexOf(key);

    return NextResponse.json(
      {
        address: who,
        chainId: chain.id,
        counts,
        points: {
          registration: breakdown.registration.toString(),
          referral: breakdown.referral.toString(),
          creation: breakdown.creation.toString(),
          trading: breakdown.trading.toString(),
          granted: breakdown.granted.toString(),
          total: breakdown.total.toString(),
        },
        rates: {
          register: card.rates.register.toString(),
          referral: card.rates.referral.toString(),
          create: card.rates.create.toString(),
          swap: card.rates.swap.toString(),
        },
        /// False when no points contract is deployed here, so the card can say the
        /// rates are indicative rather than quoting them as settled.
        ratesOnChain: card.onChain,
        rank: rankAt >= 0 ? rankAt + 1 : null,
        rankOf: index.capped ? null : order.length,
        /// True while the answer is still being assembled — a block range not read
        /// yet, a graduated pair not caught up, or a referral not verified yet — so a
        /// total may be low. Clears on its own as the reads converge.
        partial: !index.complete,
        /// The positive form of the same fact, for anything that would rather say
        /// "all-time" than "may be incomplete".
        allTime: index.complete,
      },
      { headers: cacheHeaders(EDGE_S, SWR_S) },
    );
  } catch (err) {
    console.error("[points] scan failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not read points" }, { status: 502 });
  }
}
