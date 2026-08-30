import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { isAddress } from "viem";
import { memeTokenAbi, pointsAbi } from "@/lib/abis";
import { verifyActivity } from "@/lib/activity";
import { ink, inkSepolia } from "@/lib/chains";
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
  GRANTED_EVENT,
  REDEEMED_EVENT,
  REGISTERED_EVENT,
  SWAP_EVENT,
  TOKEN_CREATED_EVENT,
  TRADE_EVENT,
  type GrantArgs,
  type RegisteredArgs,
  type TokenCreatedArgs,
  type TradeArgs,
} from "@/lib/events";
import {
  pointsFor,
  pointsFromBlock,
  RATES_FALLBACK,
  type PointEvent,
  type PointEventKind,
  type PointHistory,
  type Rates,
} from "@/lib/points";
import { allPairs, dexFor, tokensOfPairs } from "@/lib/server-dex";
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
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * One wallet's uwPoints, event by event.
 *
 * The companion to /api/points, and deliberately the mirror image of it. That route
 * reads every stream *unfiltered* and buckets by address, because a leaderboard needs
 * everybody and reading history once is the only way to afford that. This one reads the
 * same streams filtered to **one address**, because every argument that matters is
 * indexed and a topic filter on a single wallet is the cheapest question you can ask a
 * node: seven small requests per chunk, most of them returning nothing.
 *
 * Both must agree, and the agreement is structural rather than hoped for. The counts
 * come from the same events, the prices come from the same rate card, and a referral is
 * valid here exactly when `lib/activity.ts` says it is there — one shared verdict memo,
 * so a row reading "+1,000" cannot sit under a total that did not pay for it.
 *
 * **Why a list at all.** A balance is arithmetic nobody can check. It is derived from
 * public logs on every read (see UnderwaterPoints.sol on why nothing is stored), which
 * means it is reproducible in principle and completely opaque in practice — a wallet
 * looking at 128,400 has no way to ask which of its actions that was. The list is that
 * arithmetic shown: every row carries the transaction it came from, so the number stops
 * being something we assert and becomes something anybody can audit.
 *
 * Newest first and walked backwards from the head, so a page fills from the first chunk
 * or two for an active wallet and only a quiet one is followed further back — the same
 * shape as /api/trades/[token], for the same reason, under the same clock.
 *
 * The store is per wallet and it is *safe to race*, which the counting store next door
 * is not: rows are identified by transaction and log index, so reading the same log
 * twice folds into one row rather than doubling a count. Two tabs on the same profile
 * cost requests and cannot corrupt anything.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * Cache windows.
 *
 * Longer than the trade feed's and shorter than the board's. A wallet's own history is
 * the one page where the visitor knows what they just did, so it should not lag by much;
 * but the row for a trade is worth less urgently than the balance beside it, which
 * /api/points already refreshes every thirty seconds.
 *
 * No per-address memo, deliberately: `cached` is a module-scope map with no eviction, so
 * keying it by address is an entry per wallet ever queried — the one unbounded thing
 * /api/points went out of its way to remove. The CDN window above absorbs repeats
 * instead, and the row store below is bounded.
 */
const EDGE_S = 20;
const SWR_S = 120;
const PAIRS_MEMO_MS = 10 * 60_000;
const RATES_MEMO_MS = 30_000;

/**
 * Wall clock one read spends reaching backwards, in milliseconds.
 *
 * Same seven seconds and the same reasoning as /api/volume and /api/trades: a clock
 * rather than a chunk count, enforced per chunk rather than between waves, because
 * `maxDuration` is unusable on this Next version and a hung `eth_getLogs` plus its
 * retries can outlast the whole budget on its own.
 */
const REACH_MS = 7_000;

/**
 * Chunks in flight per wave — one, because a chunk here is *seven* log requests.
 *
 * The per-address filters are what make this affordable and also what make them
 * numerous: the waitlist read twice (as registrant and as referrer), the launchpad
 * twice (creator and trader sit at the same topic position under different names, so
 * they cannot share a filter the way /api/points pairs them), every pair at once, and
 * the points contract twice. Seven in flight is the neighbourhood the rest of the
 * codebase settled on against an endpoint measured dropping nineteen of forty
 * concurrent calls.
 *
 * Chunks below a contract's own deployment skip its requests entirely, so in practice a
 * deep chunk is four or five requests rather than seven — the points contract is much
 * newer than the launchpad on every chain we run on.
 */
const WAVE = 1;

/** Rows a page holds by default, and the ceiling `limit` is clamped to. */
const PAGE = 40;
const PAGE_MAX = 200;

/**
 * Rows kept per wallet, and wallets kept per instance.
 *
 * The row cap is a little above {@link PAGE_MAX} so a full page can be served with
 * something left over to prove there is more. Beyond that the walk stops being worth
 * paying for: nobody scrolls two hundred rows, and the balance is already the summary.
 */
const KEEP_ROWS = 240;
const WALLETS_MAX = 64;

/** Blocks whose timestamps are fetched per read, and how many are remembered. */
const STAMP_BUDGET = 32;
const STAMP_MAX = 20_000;

/** Symbols resolved per instance. Immutable once read, so only ever evicted. */
const SYMBOL_MAX = 4_000;

/**
 * Referrals whose activity bar is checked per read.
 *
 * Small, because this is one wallet's referrals rather than a chain's and the verdicts
 * are shared with the board — which checks a hundred and twenty a read and has probably
 * already answered these. What is left over shows as pending and clears on a later read.
 */
const VERIFY_MAX = 24;

/* ---------------------------------------------------------------------------
 * A row, as the logs give it.
 * ------------------------------------------------------------------------- */

/**
 * One event, stored unpriced.
 *
 * Rates are deliberately not baked in here. The store outlives a rate change and a
 * balance is recomputed on every read, so pricing at response time is what makes the
 * card's promise — "a rate change re-prices what is already here" — true of the list as
 * well as the total. It is the same reason /api/points stores counts rather than points.
 *
 * `at` is the event's own timestamp where the log carries one, and zero where it does
 * not: `Registered`, `TokenCreated` and `Trade` all put the time in the event, while
 * `Swap`, `Redeemed` and `Granted` leave it to the block.
 */
type Row = {
  kind: PointEventKind;
  block: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  at: number;
  token?: Address;
  /// Carried straight out of `TokenCreated`, which is the one log that names the token.
  symbol?: string;
  /// The pair a pool swap happened on, resolved to its token on the way out.
  pair?: Address;
  referee?: Address;
  isBuy?: boolean;
  venue?: "curve" | "pool";
  /// A coupon's or a grant's own value, which no rate prices.
  amount?: bigint;
  reason?: string;
};

/** Where each stream lives and the block below which it cannot have logs. */
type Sources = {
  waitlist: Address | null;
  launchpad: Address | null;
  points: Address | null;
  pairs: readonly Address[];
  floor: { waitlist: bigint; launchpad: bigint; points: bigint };
};

/**
 * Every row for one address in one range.
 *
 * Seven filters, each skipped when the range is entirely below the contract that would
 * emit it — there is no `Redeemed` before the points contract existed, and asking is a
 * request paid for a guaranteed empty answer.
 */
const rowsIn =
  (scan: LogScanClient, who: Address, src: Sources) =>
  async (r: Range): Promise<Row[]> => {
    const span = { fromBlock: r.from, toBlock: r.to } as const;
    const mine = who.toLowerCase();
    const wl = src.waitlist && r.to >= src.floor.waitlist ? src.waitlist : null;
    const lp = src.launchpad && r.to >= src.floor.launchpad ? src.launchpad : null;
    const pt = src.points && r.to >= src.floor.points ? src.points : null;
    const pairs =
      src.pairs.length && r.to >= src.floor.launchpad ? (src.pairs as Address[]) : null;

    const [joined, brought, made, traded, swapped, redeemed, granted] = await Promise.all([
      wl
        ? scan.getLogs({ address: wl, event: REGISTERED_EVENT, args: { who }, ...span })
        : [],
      wl
        ? scan.getLogs({
            address: wl,
            event: REGISTERED_EVENT,
            args: { referrer: who },
            ...span,
          })
        : [],
      lp
        ? scan.getLogs({
            address: lp,
            event: TOKEN_CREATED_EVENT,
            args: { creator: who },
            ...span,
          })
        : [],
      lp
        ? scan.getLogs({ address: lp, event: TRADE_EVENT, args: { trader: who }, ...span })
        : [],
      pairs
        ? scan.getLogs({ address: pairs, event: SWAP_EVENT, args: { to: who }, ...span })
        : [],
      pt
        ? scan.getLogs({ address: pt, event: REDEEMED_EVENT, args: { who }, ...span })
        : [],
      pt
        ? scan.getLogs({ address: pt, event: GRANTED_EVENT, args: { who }, ...span })
        : [],
    ]);

    const out: Row[] = [];
    const where = (log: {
      blockNumber: bigint | null;
      logIndex: number | null;
      transactionHash: `0x${string}` | null;
    }) => ({
      block: log.blockNumber ?? 0n,
      logIndex: log.logIndex ?? 0,
      txHash: log.transactionHash ?? ("0x" as `0x${string}`),
    });

    for (const log of joined) {
      const a = log.args as RegisteredArgs;
      out.push({ kind: "register", ...where(log), at: Number(a.at ?? 0n) });
    }
    for (const log of brought) {
      const a = log.args as RegisteredArgs;
      const referee = a.who?.toLowerCase();
      // A self-referral pays nothing on the board, so it must not appear as a row that
      // does — the wallet's own registration is already above it.
      if (!referee || referee === mine) continue;
      out.push({
        kind: "referral",
        ...where(log),
        // The referee's own registration time, which is when the referral happened.
        at: Number(a.at ?? 0n),
        referee: a.who,
      });
    }
    for (const log of made) {
      const a = log.args as TokenCreatedArgs;
      out.push({
        kind: "create",
        ...where(log),
        at: Number(a.timestamp ?? 0n),
        token: a.token,
        symbol: a.symbol,
      });
    }
    for (const log of traded) {
      const a = log.args as TradeArgs;
      out.push({
        kind: "trade",
        ...where(log),
        at: Number(a.timestamp ?? 0n),
        token: a.token,
        isBuy: a.isBuy,
        venue: "curve",
      });
    }
    for (const log of swapped) {
      out.push({
        kind: "trade",
        ...where(log),
        at: 0,
        pair: log.address as Address,
        venue: "pool",
      });
    }
    for (const log of redeemed) {
      const a = log.args as GrantArgs;
      out.push({ kind: "coupon", ...where(log), at: 0, amount: a.points ?? 0n });
    }
    for (const log of granted) {
      const a = log.args as GrantArgs & { reason?: string };
      out.push({
        kind: "grant",
        ...where(log),
        at: 0,
        amount: a.points ?? 0n,
        reason: a.reason,
      });
    }
    return out;
  };

/**
 * Newest first, one row per log.
 *
 * The dedup is what makes the store safe to write from two requests at once, and it is
 * why the unsettled tail can be re-read on every read without a queue or a diff: a log
 * is identified by its transaction and its index within it, so the same event found
 * twice collapses rather than counting twice. The bug this rules out is the one the
 * counting store next door needs a whole invariant to avoid.
 */
function newestFirst(rows: readonly Row[]): Row[] {
  const one = new Map<string, Row>();
  for (const r of rows) one.set(`${r.txHash}:${r.logIndex}`, r);
  return [...one.values()].sort((a, b) =>
    a.block === b.block ? b.logIndex - a.logIndex : b.block > a.block ? 1 : -1,
  );
}

/* ---------------------------------------------------------------------------
 * What is kept between reads.
 * ------------------------------------------------------------------------- */

/**
 * One wallet's rows and the settled range they were found in.
 *
 * `pairs` is the count of pairs the rows were scanned against. A token graduating adds a
 * venue this wallet may have traded on before we knew about it, and unlike a count a row
 * cannot be back-filled into the middle of a sorted list without knowing what is missing
 * — so the honest response is to drop this wallet's rows and walk again. Graduations are
 * rare, the walk is bounded, and the alternative is a list quietly missing pool trades
 * from before the pair was noticed.
 */
type Kept = { rows: Row[]; lo: bigint; hi: bigint; pairs: number };

const stores = new Map<string, Kept>();

/** Block timestamps, for the three logs that do not carry their own. */
const stamps = new Map<string, number>();
/** Token tickers, for the rows whose log does not name the token. */
const symbols = new Map<string, string>();

function trim<V>(map: Map<string, V>, max: number) {
  if (map.size <= max) return;
  let drop = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--drop <= 0) break;
  }
}

/* ---------------------------------------------------------------------------
 * The venues.
 * ------------------------------------------------------------------------- */

/** Every pair, and which token each one is the market for. */
type Venues = { pairs: Address[]; tokenOf: Map<string, Address> };

const NO_VENUES: Venues = { pairs: [], tokenOf: new Map() };

/**
 * The DEX's pairs and their tokens, memoised.
 *
 * The only part of a read that costs contract calls rather than log requests, and all of
 * it is immutable once resolved — which is why the window can be ten minutes. A token
 * that graduates inside that window is picked up on the next refresh and drops this
 * wallet's rows, as {@link Kept} explains.
 */
function venuesFor(
  reads: ServerClient,
  chainId: number,
  launchpad: Address | null,
): Promise<Venues> {
  return cached<Venues>(`points-history-venues:${chainId}`, PAIRS_MEMO_MS, async () => {
    if (!launchpad) return NO_VENUES;
    const dex = await dexFor(reads, chainId, launchpad);
    if (!dex.factory) return NO_VENUES;
    const pairs = await allPairs(reads, dex.factory);
    return { pairs, tokenOf: await tokensOfPairs(reads, dex.weth, pairs) };
  })
    .then(({ value }) => value)
    .catch(() => NO_VENUES);
}

/**
 * The rate card, from the chain if the contract is deployed here.
 *
 * Deliberately the same memo key /api/points reads it under — `cached` lives in
 * lib/server-rpc.ts, so one entry per chain serves both routes. That is the point: a page
 * showing rows priced from one card beside a total priced from another would be showing a
 * list that does not add up to the number above it.
 */
function ratesFor(
  reads: ServerClient,
  chainId: number,
  points: Address | null,
): Promise<{ rates: Rates; onChain: boolean }> {
  return cached(`points-rates:${chainId}`, RATES_MEMO_MS, async () => {
    if (!points) return { rates: RATES_FALLBACK, onChain: false };
    const [card] = (await reads.readContract({
      address: points,
      abi: pointsAbi,
      functionName: "rateCard",
    })) as [Rates, bigint];
    return {
      rates: {
        register: card.register,
        referral: card.referral,
        create: card.create,
        swap: card.swap,
      },
      onChain: true,
    };
  })
    .then(({ value }) => value)
    .catch(() => ({ rates: RATES_FALLBACK, onChain: false }));
}

/* ---------------------------------------------------------------------------
 * Filling in what the logs leave out.
 * ------------------------------------------------------------------------- */

/**
 * Timestamps for the rows that have none.
 *
 * Newest blocks first and at most {@link STAMP_BUDGET} per read, so a page's visible
 * rows are dated before a deep row nobody has scrolled to. Blocks are immutable, so an
 * entry is never wrong, only ever evicted. A row still missing its stamp renders as its
 * block number rather than as a guessed date — see `at` in {@link PointEvent}.
 *
 * `includeTransactions` is deliberately off: unlike the trade feed this needs no sender,
 * only the time, and a busy block's transaction list is far more payload than a page of
 * history is worth.
 */
async function stamp(scan: LogScanClient, chainId: number, rows: readonly Row[]) {
  const missing = [
    ...new Set(
      rows.filter((r) => !r.at && !stamps.has(`${chainId}:${r.block}`)).map((r) => r.block),
    ),
  ]
    .sort((a, b) => (a > b ? -1 : 1))
    .slice(0, STAMP_BUDGET);
  if (missing.length === 0) return;

  await lanes(
    missing,
    async (blockNumber) => {
      try {
        const block = await scan.getBlock({ blockNumber });
        stamps.set(`${chainId}:${blockNumber}`, Number(block.timestamp));
      } catch {
        // An undated row is a row with a block number on it, which is worse copy and
        // not a wrong claim. Asked again next read.
      }
    },
    8,
  );
  trim(stamps, STAMP_MAX);
}

/**
 * Tickers for the tokens in a page.
 *
 * `TokenCreated` names its own token, so a launch row needs nothing. A curve trade
 * carries the address only, and a pool swap not even that — hence `tokenOf`. One
 * multicall for whatever is left, memoised for the life of the process because a
 * token's symbol is set in its constructor.
 */
async function tickers(reads: ServerClient, chainId: number, tokens: readonly Address[]) {
  const wanted = [...new Set(tokens.map((t) => t.toLowerCase()))].filter(
    (t) => !symbols.has(`${chainId}:${t}`),
  );
  if (wanted.length === 0) return;

  const got = await Promise.allSettled(
    wanted.map((token) =>
      reads.readContract({
        address: token as Address,
        abi: memeTokenAbi,
        functionName: "symbol",
      }),
    ),
  );
  wanted.forEach((token, i) => {
    const r = got[i];
    if (r.status === "fulfilled" && typeof r.value === "string") {
      symbols.set(`${chainId}:${token}`, r.value);
    }
  });
  trim(symbols, SYMBOL_MAX);
}

/* ---------------------------------------------------------------------------
 * The read.
 * ------------------------------------------------------------------------- */

async function readHistory(
  chain: Chain,
  who: Address,
  want: number,
  where: { waitlist: Address | null; launchpad: Address | null; points: Address | null },
): Promise<PointHistory> {
  const deadline = Date.now() + REACH_MS;
  const reads = serverClient(chain);
  const scan = logClient(chain);
  const { waitlist, launchpad, points } = where;

  const latest = await reads.getBlockNumber();

  // Where each stream starts. Derived from the deployments rather than configured, for
  // the reason lib/chunks.ts gives, and kept apart rather than reduced to one floor so a
  // chunk can skip the contracts that did not exist in it.
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
  if (found.length === 0) {
    return { events: [], more: false, allTime: true, partial: false };
  }

  const derived = found.reduce((lo, f) => (f.block < lo ? f.block : lo), found[0].block);
  // Honoured only downwards, exactly as in /api/points: earlier is safe and merely slow,
  // later drops history silently.
  const configured = pointsFromBlock(chain.id);
  const from = configured > 0n && configured < derived ? configured : derived;
  const exact = found.every((f) => f.exact) && from <= derived;

  const venues = await venuesFor(reads, chain.id, launchpad);
  const src: Sources = {
    waitlist,
    launchpad,
    points,
    pairs: venues.pairs,
    floor: {
      waitlist: wlFloor?.block ?? 0n,
      launchpad: lpFloor?.block ?? 0n,
      points: ptFloor?.block ?? 0n,
    },
  };

  // Below this logs are final and worth keeping; above it the sequencer may still change
  // its mind, so it is re-read every time.
  const settledTo = latest > from + REORG_TAIL ? latest - REORG_TAIL : from - 1n;

  const key =
    `${chain.id}:${who}:${waitlist ?? "-"}:${launchpad ?? "-"}:${points ?? "-"}`.toLowerCase();
  const kept = stores.get(key);
  const held: Kept =
    kept && kept.lo >= from && kept.lo <= settledTo + 1n && kept.pairs === venues.pairs.length
      ? kept
      : { rows: [], lo: settledTo + 1n, hi: settledTo, pairs: venues.pairs.length };

  const read = rowsIn(scan, who, src);

  // The settled blocks that appeared since the last read and the unsettled tail, in one
  // wave: independent ranges of one chunk each, and no reason to pay two round trips.
  // What differs is what happens to the rows — the sliver is settled and kept, the tail
  // is re-read every time and never kept.
  const ahead = ranges(held.hi + 1n, settledTo);
  // One lane, not two: these are two chunks of seven requests each, and fourteen
  // concurrent calls is past where this endpoint starts dropping them. Two sequential
  // waves of seven costs a round trip and keeps the read inside its budget.
  const edges = await lanes([...ahead, ...ranges(settledTo + 1n, latest)], read, WAVE);
  if (ahead.length) {
    held.rows.push(...edges.slice(0, ahead.length).flat());
    held.hi = settledTo;
  }
  const tail = edges.slice(ahead.length).flat();

  // Backwards until the page is full — one row past `want`, so "there is more" is a fact
  // rather than an assumption — or until the clock runs out. An active wallet never
  // touches its older chunks; a quiet one reaches further back on each read.
  let ranOut = false;
  if (held.rows.length <= want && held.lo > from) {
    const { results, reached, ranOut: out } = await newestChunksUntil(
      ranges(from, held.lo - 1n),
      read,
      (batch) => held.rows.length + batch.flat().length > want,
      WAVE,
      deadline,
    );
    held.rows.push(...results.flat());
    held.lo = reached;
    ranOut = out;
  }

  held.rows = newestFirst(held.rows).slice(0, KEEP_ROWS);
  // Re-inserted rather than merely written, so the eviction below is least-recently-used
  // and not merely oldest-first.
  stores.delete(key);
  stores.set(key, held);
  trim(stores, WALLETS_MAX);

  const rows = newestFirst([...tail, ...held.rows]);
  const page = rows.slice(0, want);

  // Only for the rows being returned. A deep row in the store costs nothing until
  // somebody asks for it.
  const pooled = page
    .map((r) => (r.pair ? venues.tokenOf.get(r.pair.toLowerCase()) : undefined))
    .filter((t): t is Address => !!t);
  const named = page.filter((r) => r.token && !r.symbol).map((r) => r.token as Address);
  const referees = page
    .filter((r) => r.kind === "referral" && r.referee)
    .map((r) => (r.referee as Address).toLowerCase());

  // Three independent fill-ins, none waiting on another. The verdicts are shared with
  // the board, which has probably already answered most of these; this route never
  // prunes the memo, since it only ever holds a subset of a chain's referrals.
  const [, , valid] = await Promise.all([
    stamp(scan, chain.id, page),
    tickers(reads, chain.id, [...pooled, ...named]),
    referees.length
      ? verifyActivity(
          referees,
          { mainnet: serverClient(ink), sepolia: serverClient(inkSepolia) },
          deadline,
          { max: VERIFY_MAX },
        )
      : Promise.resolve({ pass: new Set<string>(), behind: 0 }),
  ]);

  const { rates } = await ratesFor(reads, chain.id, points);

  let undated = 0;
  const events: PointEvent[] = page.map((r) => {
    const token = r.token ?? (r.pair ? venues.tokenOf.get(r.pair.toLowerCase()) : undefined);
    const symbol =
      r.symbol ?? (token ? symbols.get(`${chain.id}:${token.toLowerCase()}`) : undefined);
    const at = r.at || stamps.get(`${chain.id}:${r.block}`) || 0;
    if (!at) undated++;

    const cleared = r.referee ? valid.pass.has(r.referee.toLowerCase()) : false;
    const points =
      r.kind === "register"
        ? rates.register
        : r.kind === "referral"
          ? cleared
            ? rates.referral
            : 0n
          : r.kind === "create"
            ? rates.create
            : r.kind === "trade"
              ? rates.swap
              : (r.amount ?? 0n);

    return {
      kind: r.kind,
      block: r.block,
      logIndex: r.logIndex,
      txHash: r.txHash,
      at,
      points,
      ...(token ? { token } : {}),
      ...(symbol ? { symbol } : {}),
      ...(r.referee ? { referee: r.referee, pending: !cleared } : {}),
      ...(r.isBuy === undefined ? {} : { isBuy: r.isBuy }),
      ...(r.venue ? { venue: r.venue } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    };
  });

  const allTime = held.lo <= from && exact && !ranOut;
  return {
    events,
    // Rows already found and not shown, or blocks still to walk.
    more: rows.length > want || !allTime,
    allTime,
    // A date not fetched yet or a referral not verified yet. Both clear on their own.
    partial: undated > 0 || valid.behind > 0,
  };
}

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

  const asked = Number(url.searchParams.get("limit") ?? PAGE);
  const want = Number.isFinite(asked)
    ? Math.min(PAGE_MAX, Math.max(1, Math.trunc(asked)))
    : PAGE;

  const waitlist = waitlistFor(chain.id);
  const launchpad = launchpadFor(chain.id);
  const points = pointsFor(chain.id);
  if (!waitlist && !launchpad) {
    return NextResponse.json({ error: "nothing deployed on this chain" }, { status: 404 });
  }

  try {
    const history = await readHistory(chain, raw as Address, want, {
      waitlist,
      launchpad,
      points,
    });
    const body: Wire<PointHistory> = encodeWire(history);
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    console.error(
      `[points/history] ${raw} on chain ${chain.id} failed:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "could not read history" }, { status: 502 });
  }
}
