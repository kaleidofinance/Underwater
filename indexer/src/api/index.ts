import { db } from "ponder:api";
import schema from "ponder:schema";
import {
  account,
  candle,
  pointGrant,
  protocolFee,
  registration,
  token,
  trade,
} from "ponder:schema";
import {
  and,
  asc,
  client,
  count,
  desc,
  eq,
  graphql,
  gte,
  inArray,
  lt,
  sql,
} from "ponder";
import { Hono } from "hono";
import { configuredNetworks } from "../../networks";

/**
 * The routes the app reads instead of deriving the market from RPC.
 *
 * Each one is the exact answer an existing route in `web/app/api/` assembles from
 * contract reads and log scans, expressed as SQL over rows that were already final when
 * the block landed. `web/lib/indexer.ts` is the other half: it maps these payloads onto
 * the app's own `MarketState` and `Volume`, and falls back to the scan when this service
 * has nothing to offer.
 *
 * The mapping lives there rather than here, and that is deliberate. Emitting the app's
 * wire shapes directly would make this API a private ABI of one Next.js app — it would
 * have to import the app's types to stay honest, which is exactly what the vendoring in
 * `scripts/` exists to avoid. So these routes answer in their own terms and the consumer
 * adapts. `bigint` still crosses as a decimal string, because that is the one convention
 * both sides already share (see `web/lib/wire.ts`).
 *
 * The two middlewares below are what make the *rest* of the surface — a token page's
 * full history, a wallet's trades, an arbitrary sort — cost nothing to add. Both have
 * to be mounted explicitly; neither is on by default.
 */
const app = new Hono();

/** Interactive GraphQL over every table, derived from the schema. */
app.use("/graphql", graphql({ db, schema }));

/**
 * SQL over HTTP, for `@ponder/client` and `@ponder/react` in the browser.
 *
 * Read-only and schema-scoped — the client sends a query, not a connection string.
 * This is the route that would let a chart subscribe to live rows instead of polling
 * `/api/volume` every three seconds.
 */
app.use("/sql/*", client({ db, schema }));

/** `bigint` → decimal string, recursively, matching what the app's routes emit today. */
function serialise(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, serialise(v)]),
    );
  }
  return value;
}

/**
 * The chains this process indexes, by id.
 *
 * Read once and held, because it is derived from the environment and the environment
 * does not change under a running process. Lazily rather than at module load so that a
 * misconfiguration surfaces as a failing request with a message rather than as a module
 * that would not import — although in practice Ponder's own config throws first.
 */
let indexed:
  | Map<
      number,
      {
        launchpad: string;
        waitlist: string | null;
        points: string | null;
        startBlock: number;
      }
    >
  | undefined;

function chainsIndexed() {
  if (!indexed) {
    indexed = new Map(
      configuredNetworks().map((net) => [
        net.id,
        {
          launchpad: net.launchpad,
          waitlist: net.waitlist,
          points: net.points,
          startBlock: net.startBlock,
        },
      ]),
    );
  }
  return indexed;
}

const chainOf = (c: { req: { query: (k: string) => string | undefined } }) =>
  Number(c.req.query("chain") ?? 57073);

/**
 * Which chains this service can answer for, so a caller can tell "not mine" from
 * "nothing here".
 *
 * The distinction is invisible in the tables and it decides what the app does: a
 * `SELECT` over a chain this process was never configured for returns no rows, exactly
 * like a chain that is indexed and has had no launches. One of those means fall back to
 * the RPC scan and the other means render an empty market, and getting it backwards
 * shows a visitor an empty market on a chain that has launches.
 *
 * `launchpad` is here to be checked rather than read. An indexer aimed at a different
 * deployment of the same contract on the same chain id — a redeploy, a stale variable —
 * serves rows that are internally consistent and describe a market nobody is looking at,
 * which is the one failure mode that survives every other check. The app compares this
 * against its own address and falls back if they differ; see `web/lib/indexer.ts`.
 *
 * `waitlist` and `points` are there for the same check and one more. They are optional
 * per chain, so null is an ordinary answer — but an indexer serving a chain whose waitlist
 * it does not watch would report balances missing every registration, and a balance short
 * by `rates.register` looks exactly like a wallet that never registered. So the app
 * requires these to match its own before it will read points from here, and a null on
 * either side against an address on the other is a mismatch rather than a shrug.
 *
 * `startBlock` is the floor of everything below: the block the launchpad was deployed in,
 * which is what makes "how much history does this cover" a number rather than a guess.
 *
 * Called `/chains` and not `/status` because `/status` is taken. Ponder registers
 * `/metrics`, `/health`, `/ready` and `/status` on the Hono instance that *hosts* this
 * one and mounts this app underneath them, so the outer handler wins and a route by that
 * name here would simply never be reached (`ponder/dist/esm/server/index.js:68-82`).
 * Its `/status` is the more useful of the two anyway — it reports each chain's indexed
 * head, which is a thing only Ponder knows.
 *
 * Also not on this payload: whether the backfill has finished. Ponder answers that at
 * `/ready`, which returns 200 only once every chain has caught up — a signal this app
 * cannot see from inside a route handler, and one the caller should be asking for anyway.
 */
app.get("/chains", (c) =>
  c.json({
    chains: [...chainsIndexed()].map(([chainId, net]) => ({
      chainId,
      launchpad: net.launchpad,
      waitlist: net.waitlist,
      points: net.points,
      startBlock: String(net.startBlock),
    })),
  }),
);

/** 404 rather than an empty answer, for the reason `/chains` gives. */
const notIndexed = (chainId: number) =>
  ({ error: "chain not indexed", chainId }) as const;

/**
 * A whole, non-negative query parameter, clamped.
 *
 * `Number("page2")` is NaN and so is `Number("")`, and either one reaching `.limit()` or
 * `.offset()` is a 500 on a request that deserved a clamp. Worth hardening now that the
 * app puts real values here rather than always sending the same two: a hand-typed URL is
 * a supported caller, and a paging control off by one row should not be an error page.
 */
const bounded = (raw: string | undefined, fallback: number, cap: number) => {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), cap);
};

/**
 * The market list — what `/api/market` reads with `MARKET_LIMIT × PER_LISTING`
 * contract calls per three-second window.
 *
 * The interesting part is not that it is one query, it is `sort` and `offset`: the RPC
 * path has neither, because both need every launch's figures to exist before you can
 * order by them and it only has the hundred it decided to read. Here the cap is a page
 * size, and the app drives both — see `MarketSort` in web/lib/market.ts.
 *
 * Five orderings, of which the browser can manage three for itself over a page it has
 * already been sent (`new`, `progress`, `cap` are all on the row). `volume` and `active`
 * are the two that only exist here, because ordering by them means ordering rows the app
 * was never sent. `volume` is the lifetime counter, not a window — "most traded ever",
 * which is a different question from "busiest today" and the only one a column can answer
 * without an aggregate over `trade`.
 *
 * `tokenCount` is every launch on the chain rather than the page's length, which is the
 * one figure on this payload that is not a column: the app shows it to say how much of
 * the market is outside the window it is displaying, and reads it off the launchpad's
 * own counter today. A `count(*)` over rows written by `TokenCreated` is the same
 * number — one row per launch, by construction. It is also what bounds the paging, so it
 * is on every page rather than only the first.
 */
app.get("/market", async (c) => {
  const chainId = chainOf(c);
  if (!chainsIndexed().has(chainId)) return c.json(notIndexed(chainId), 404);

  const limit = bounded(c.req.query("limit"), 100, 500);
  const offset = bounded(c.req.query("offset"), 0, 1_000_000);

  // `NULLS LAST` on `lastTradeAt`, which is nullable and null for every launch that has
  // never traded. Postgres sorts nulls *first* in a descending order, so the plain
  // `desc()` the other four use would open "recently traded" with the launches that have
  // never been traded at all — the exact inverse of the sort.
  const order = {
    new: desc(token.createdAt),
    progress: desc(token.progressBps),
    cap: desc(token.marketCapWei),
    volume: desc(token.volumeWei),
    active: sql`${token.lastTradeAt} desc nulls last`,
  }[c.req.query("sort") ?? "new"] ?? desc(token.createdAt);

  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(token)
      .where(eq(token.chainId, chainId))
      .orderBy(order)
      .limit(limit)
      .offset(offset),
    db.select({ n: count() }).from(token).where(eq(token.chainId, chainId)),
  ]);

  return c.json(
    serialise({ chainId, tokenCount: String(counted?.n ?? 0), listings: rows }),
  );
});

/**
 * How many launches an `opens` map covers, matching `MARKET_LIMIT` in web/lib/market.ts.
 *
 * A price per launch is the one thing on this payload whose size grows with the market,
 * and the app can only render a change beside a row it is showing — so the bound is the
 * page rather than the table. A caller wanting the change on page two asks for the
 * offset it is displaying.
 */
const OPENS_LIMIT = 100;

/**
 * Sums below are `coalesce(sum(…), 0)::text`, which is three decisions worth naming.
 *
 * `coalesce`, because `sum()` over no rows is SQL NULL and every consumer of these is a
 * `BigInt()` — so the zero is established in Postgres rather than downstream, where
 * drizzle's decoder for the column would have had to be trusted to pass a null through
 * unmapped. `::text`, because the underlying type is `numeric(78, 0)`: wide enough that
 * the driver would otherwise be choosing between a lossy float and a string on its own.
 *
 * And the column is always interpolated from the schema, never spelled out. Ponder runs
 * drizzle with `casing: "snake_case"`, which renames `priceE18` to `price_e_18` rather
 * than the `price_e18` anybody would guess, and a hand-written name inside a template is
 * a string tsc will not check.
 */

/** Every fee leg the app names, with the ones no handler writes explicitly zero. */
type Legs = { creation: string; trade: string; graduation: string; swap: string };

const noLegs = (): Legs => ({
  creation: "0",
  trade: "0",
  graduation: "0",
  swap: "0",
});

/**
 * The revenue ledger, summed per leg over one window.
 *
 * Grouped rather than four queries, and returned as named legs rather than a total,
 * because the app's `Fees` keeps them apart on purpose: two of these are exact sums of
 * what the contract said it took, and telling them apart from the derived one is the
 * whole point of the type. `swap` is always zero here — it accrues as unminted LP and
 * appears in no log, so the app derives it from pool volume and states that it did.
 */
async function legsOf(chainId: number, since?: number): Promise<Legs> {
  const rows = await db
    .select({
      kind: protocolFee.kind,
      amount: sql<string>`coalesce(sum(${protocolFee.amountWei}), 0)::text`,
    })
    .from(protocolFee)
    .where(
      since === undefined
        ? eq(protocolFee.chainId, chainId)
        : and(eq(protocolFee.chainId, chainId), gte(protocolFee.timestamp, since)),
    )
    .groupBy(protocolFee.kind);

  const out = noLegs();
  for (const row of rows) {
    if (row.kind in out) out[row.kind as keyof Legs] = row.amount;
  }
  return out;
}

/**
 * Volume and trade count over one window, with the pool's share of it kept apart.
 *
 * `poolEth` is not a second total, it is the part of `eth` that moved on a DEX pair —
 * separated because the protocol's cut of a pool swap is the one fee leg that appears
 * in no log and has to be derived from volume. Deriving it here would mean this service
 * deciding whether the DEX fee switch is on, which is pair state it does not track, so
 * the split is published and the app applies its own rate and its own gate. See
 * `POOL_CUT_BPS` in web/app/api/volume/route.ts.
 */
async function movedIn(chainId: number, since?: number) {
  const rows = await db
    .select({
      source: trade.source,
      eth: sql<string>`coalesce(sum(${trade.ethAmount}), 0)::text`,
      trades: count(),
    })
    .from(trade)
    .where(
      since === undefined
        ? eq(trade.chainId, chainId)
        : and(eq(trade.chainId, chainId), gte(trade.timestamp, since)),
    )
    .groupBy(trade.source);

  let eth = 0n;
  let poolEth = 0n;
  let trades = 0;
  for (const row of rows) {
    const moved = BigInt(row.eth);
    eth += moved;
    if (row.source === "pool") poolEth += moved;
    trades += Number(row.trades);
  }
  return { eth: eth.toString(), poolEth: poolEth.toString(), trades };
}

/**
 * What each launch cost when the window opened, keyed by lowercased address.
 *
 * The same rule the app's scan applies, which is worth stating because the obvious
 * query is not it: the open is the price of the last fill **before** the window, and
 * only the first fill *inside* it when there is no earlier one. Taking the first fill
 * inside the window unconditionally would measure a day's change from wherever the
 * day's first trade left the price, not from where the price was a day ago — a launch
 * that gapped up on its first trade of the morning would report no gain at all.
 *
 * The fallback is the case of a launch younger than the window, where there is no
 * earlier price because there was no token, so its change runs from its first trade.
 *
 * A launch with neither is **absent rather than zero**, which is the app's convention
 * and the reason `Opens` is a sparse map: "it has not moved" and "nothing here says
 * what it was worth" are different answers, and a zero would render as a change of
 * infinity. A launch that has never traded at all falls in the second case — its row
 * does hold a price, and using it would show a truthful 0.0%, but that is a change to
 * what the market renders rather than a change of where the number comes from.
 *
 * Bounded to the page being displayed — see {@link OPENS_LIMIT}. Two `DISTINCT ON`
 * passes rather than a window function because Postgres gets the first row per group in
 * one index pass either way, and this spells the tie-break explicitly: two fills in the
 * same second are ordered by block and then by log index, which is a total order over
 * logs. Both matter on these chains — Ink produces a block a second and Robinhood ten,
 * so a second holds several blocks, and a single block holds every fill in it.
 */
async function opensIn(chainId: number, since: number, limit: number, offset: number) {
  const page = await db
    .select({ address: token.address })
    .from(token)
    .where(eq(token.chainId, chainId))
    .orderBy(desc(token.createdAt))
    .limit(limit)
    .offset(offset);

  const addresses = page.map((row) => row.address);
  if (addresses.length === 0) return {};

  const onPage = and(eq(trade.chainId, chainId), inArray(trade.token, addresses));

  const [before, inside] = await Promise.all([
    db
      .selectDistinctOn([trade.token], { token: trade.token, price: trade.priceE18 })
      .from(trade)
      .where(and(onPage, lt(trade.timestamp, since)))
      .orderBy(
        trade.token,
        desc(trade.timestamp),
        desc(trade.blockNumber),
        desc(trade.logIndex),
      ),
    db
      .selectDistinctOn([trade.token], { token: trade.token, price: trade.priceE18 })
      .from(trade)
      .where(and(onPage, gte(trade.timestamp, since)))
      .orderBy(
        trade.token,
        asc(trade.timestamp),
        asc(trade.blockNumber),
        asc(trade.logIndex),
      ),
  ]);

  const out: Record<string, string> = {};
  // Inside first, so `before` overwrites it where both exist — the precedence above.
  for (const row of inside) out[row.token.toLowerCase()] = row.price.toString();
  for (const row of before) out[row.token.toLowerCase()] = row.price.toString();
  return out;
}

/**
 * Volume, revenue and per-launch opens — all time and over a rolling window, together.
 *
 * Worth comparing with what it replaces. `/api/volume` walks about ten chunked
 * `eth_getLogs` per chain, twice over (curve events and pair events), into a
 * module-scope `Map` that is rebuilt on every cold lambda in every region; the window it
 * reports is whatever it managed to scan, and its "all time" means "since this instance
 * started". Here both are predicates on an index, `seconds` is exactly 86,400 because
 * the boundary is a number rather than a scan depth, and all time means all time.
 *
 * The fee legs are exact in a way the scan's cannot be. `/api/volume` values every
 * launch that ever happened at *today's* `creationFee`, because a counter is all it has;
 * these rows were each written with the fee in force at that launch's own block. On Ink
 * Sepolia the two disagree by the whole leg — the fee was zero when both tokens launched
 * and is 610816335672081 wei now — so the honest figure is smaller than the scanned one.
 *
 * `startBlock` is on the payload so a caller can say what these figures cover without a
 * second request. The other end of that range is the *indexed head*, which is Ponder's
 * own `/status` and not a column here: the last block that produced a fill is a different
 * number, and a quiet market would make it look as though indexing had stopped.
 */
app.get("/volume", async (c) => {
  const chainId = chainOf(c);
  if (!chainsIndexed().has(chainId)) return c.json(notIndexed(chainId), 404);

  const seconds = Math.min(Number(c.req.query("seconds") ?? 86_400), 7 * 86_400);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const limit = Math.min(Number(c.req.query("limit") ?? OPENS_LIMIT), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const [all, allLegs, day, dayLegs, opens] = await Promise.all([
    movedIn(chainId),
    legsOf(chainId),
    movedIn(chainId, since),
    legsOf(chainId, since),
    opensIn(chainId, since, limit, offset),
  ]);

  return c.json({
    chainId,
    startBlock: String(chainsIndexed().get(chainId)?.startBlock ?? 0),
    all: { ...all, fees: allLegs },
    day: { seconds, ...day, fees: dayLegs, opens },
  });
});

/**
 * Candles for one launch — the thing the app cannot currently offer at all.
 *
 * `/api/volume` reconstructs a coarse price track from a day of logs because that is
 * the only window it has. Here the range is the caller's: `interval` picks the bucket
 * width and `limit` the count, and a year of daily candles is the same query cost as an
 * hour of minutes.
 */
app.get("/candles/:token", async (c) => {
  const chainId = chainOf(c);
  if (!chainsIndexed().has(chainId)) return c.json(notIndexed(chainId), 404);

  const address = c.req.param("token").toLowerCase() as `0x${string}`;
  const interval = Number(c.req.query("interval") ?? 300);
  const limit = Math.min(Number(c.req.query("limit") ?? 288), 1_000);

  const rows = await db
    .select()
    .from(candle)
    .where(
      and(
        eq(candle.chainId, chainId),
        eq(candle.token, address),
        eq(candle.interval, interval),
      ),
    )
    .orderBy(desc(candle.bucket))
    .limit(limit);

  return c.json(serialise({ chainId, token: address, interval, candles: rows.reverse() }));
});

// ─── uwPoints ─────────────────────────────────────────────────────────────

/**
 * The rate card is a *parameter* here, not a column.
 *
 * `UnderwaterPoints` stores rates and a `granted` mapping and nothing else; a balance is
 * `rates × counts + granted`, recomputed on every read, so moving a rate re-prices every
 * wallet's whole history. This service therefore indexes counts and never rates — see the
 * `account` docblock in ponder.schema.ts — which leaves one thing it cannot do alone:
 * order wallets by points. So the caller, which has already read the card from the chain
 * for its own display, sends it along and the ranking happens under the same numbers the
 * card is showing. A rank computed here under a stale rate card would disagree with the
 * balance printed next to it, which is worse than no rank.
 *
 * Defaults match `RATES_FALLBACK` in web/lib/points.ts, so a caller that omits them gets
 * the same ordering the app falls back to when the contract read fails.
 */
const RATE_DEFAULTS = {
  register: 10_000n,
  referral: 1_000n,
  create: 20_000n,
  swap: 10n,
} as const;

const MAX_U64 = (1n << 64n) - 1n;

/**
 * One rate off the query string, or the default.
 *
 * Strict digits rather than `Number()`, for two reasons that both end in a wrong answer
 * rather than an error: these are `uint64` in the contract and a float would round the
 * large ones, and the validated value is interpolated into SQL with `sql.raw` below —
 * which is safe only because nothing but digits can reach it. A malformed rate falls back
 * instead of throwing, matching how the app treats an unreadable rate card.
 */
const rateOf = (raw: string | undefined, fallback: bigint) => {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d{1,20}$/.test(trimmed)) return fallback;
  const n = BigInt(trimmed);
  return n <= MAX_U64 ? n : fallback;
};

/** An address off the query string, lowercased. Null when it is not one. */
const addressOf = (raw: string | undefined) => {
  const trimmed = (raw ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? (trimmed as `0x${string}`) : null;
};

/** A wallet that has done nothing — the honest answer for an address with no row. */
const noAccount = (address: `0x${string}`) => ({
  address,
  registered: false,
  position: null,
  registeredAt: null,
  referrer: null,
  referrals: 0,
  creates: 0,
  trades: 0,
  granted: 0n,
});

/**
 * How many referred wallets a page carries.
 *
 * Matches `VERIFY_MAX` in web/app/api/points/route.ts, because that is what the list is
 * for: the app gates each referral on the referred wallet having done something on-chain
 * since, and it checks at most this many per request. Sending more would be sending
 * addresses the caller is about to ignore.
 */
const REFERRALS_LIMIT = 120;

/**
 * One wallet's counts, its downline, and its rank — what `/api/points` walks all of
 * history for.
 *
 * This is the route with the largest gap between the two implementations, because the scan
 * it replaces is the one that cannot be windowed. Volume degrades gracefully to "the last
 * day"; a points balance is a total since the deployment, so the app reads five log streams
 * from `POINTS_FROM_BLOCK` to head, on every cold instance, and gives up with `partial: true`
 * when it runs out of time. Here it is four columns on one row.
 *
 * `ahead` is the other half. The app currently materialises the entire leaderboard in a
 * lambda to learn one wallet's position in it — `BOARD_LIMIT = 20_000` is the surrender to
 * that — where a rank is `count(*)` over wallets scoring higher. No index can serve that
 * predicate, since the score is an expression that changes with the rate card, but a
 * sequential count over one chain's accounts is a different order of cost from building
 * every wallet's tally in memory.
 *
 * **One documented inexactness**, and it is the reason `ahead` is a separate number from
 * the counts rather than a rank the app can derive: the score above uses `referrals`,
 * every registration through a wallet's link, while the balance the card prints uses the
 * subset that clears the activity bar. That bar needs a nonce and two lending positions on
 * other chains — state, not logs, so not indexable here — and the app checks at most
 * `VERIFY_MAX` of them per request anyway. So a rank can place a wallet above another it
 * has not out-earned, bounded by `rates.referral × (referrals - validReferrals)`. The
 * alternative is no rank at all, or a rank built by re-scanning history, which is the
 * thing being replaced.
 */
app.get("/points", async (c) => {
  const chainId = chainOf(c);
  const net = chainsIndexed().get(chainId);
  if (!net) return c.json(notIndexed(chainId), 404);

  const address = addressOf(c.req.query("address"));
  if (!address) return c.json({ error: "address required" }, 400);

  const rates = {
    register: rateOf(c.req.query("rRegister"), RATE_DEFAULTS.register),
    referral: rateOf(c.req.query("rReferral"), RATE_DEFAULTS.referral),
    create: rateOf(c.req.query("rCreate"), RATE_DEFAULTS.create),
    swap: rateOf(c.req.query("rSwap"), RATE_DEFAULTS.swap),
  };

  const limit = bounded(c.req.query("limit"), REFERRALS_LIMIT, 500);

  // `numeric` throughout rather than `bigint`: `granted` is a uint256 and the rates are
  // uint64, so the products overflow a 64-bit integer long before the values do. Every
  // rate is interpolated with `sql.raw` because it has been validated to digits by
  // `rateOf`; the columns are interpolated from the schema because drizzle's
  // `casing: "snake_case"` renames them in ways no hand-written string reliably guesses.
  const score = sql`(
    case when ${account.registered} then ${sql.raw(rates.register.toString())}::numeric else 0 end
    + ${account.referrals}::numeric * ${sql.raw(rates.referral.toString())}::numeric
    + ${account.creates}::numeric * ${sql.raw(rates.create.toString())}::numeric
    + ${account.trades}::numeric * ${sql.raw(rates.swap.toString())}::numeric
    + ${account.granted}::numeric
  )`;

  const [mine, participants, downline] = await Promise.all([
    db
      .select()
      .from(account)
      .where(and(eq(account.chainId, chainId), eq(account.address, address)))
      .limit(1),
    db.select({ n: count() }).from(account).where(eq(account.chainId, chainId)),
    // `limit + 1` so `referralsMore` is a fact about the table rather than a guess from a
    // full page — the caller needs to know whether the activity check it is about to run
    // covers the whole downline or only the head of it.
    db
      .select({ who: registration.who })
      .from(registration)
      .where(
        and(eq(registration.chainId, chainId), eq(registration.referrer, address)),
      )
      .orderBy(desc(registration.blockNumber), desc(registration.logIndex))
      .limit(limit + 1),
  ]);

  const row = mine[0] ?? noAccount(address);

  const own =
    (row.registered ? rates.register : 0n) +
    BigInt(row.referrals) * rates.referral +
    BigInt(row.creates) * rates.create +
    BigInt(row.trades) * rates.swap +
    row.granted;

  // Computed from `row` in JS rather than asked of Postgres a second time, so the number
  // the count is taken against is exactly the one this response reports. Two evaluations
  // of the same expression a few milliseconds apart could straddle a write.
  const [counted] = await db
    .select({ n: count() })
    .from(account)
    .where(
      and(eq(account.chainId, chainId), sql`${score} > ${sql.raw(own.toString())}`),
    );

  return c.json(
    serialise({
      chainId,
      startBlock: String(net.startBlock),
      participants: String(participants[0]?.n ?? 0),
      account: {
        address: row.address,
        registered: row.registered,
        position: row.position,
        registeredAt: row.registeredAt,
        referrer: row.referrer,
        referrals: row.referrals,
        creates: row.creates,
        trades: row.trades,
        granted: row.granted,
      },
      referrals: downline.slice(0, limit).map((r) => r.who),
      referralsMore: downline.length > limit,
      ahead: String(counted?.n ?? 0),
      rates,
    }),
  );
});

/** Rows per history page, matching `PAGE` in web/app/api/points/history/route.ts. */
const HISTORY_LIMIT = 40;

/**
 * Every point-earning thing one wallet did, newest first.
 *
 * Five queries over four tables, merged and sorted by `(blockNumber, logIndex)` — which is
 * the only total order over logs, and the reason both columns exist on every table here.
 * A timestamp is not enough on these chains: Robinhood produces ten blocks a second, so a
 * second holds several blocks, and a block holds every fill in it.
 *
 * Deliberately not a `pointEvent` table with a row per event. That table would be a points
 * ledger, which the contract refuses to be on purpose — every row would carry a price, and
 * a rate change would make every one of them wrong. It would also mean an extra write on
 * the hot path for every trade, to store what `trade` already stores.
 *
 * The rows are not priced. `points` per row is `rates × 1` and the rate card is read from
 * the chain by the caller, so pricing here would mean this service holding an opinion
 * about a number it does not read. The caller maps these onto `PointEvent` and applies the
 * card it is already displaying — see `indexedPointHistory` in web/lib/indexer.ts.
 *
 * `more` is derived from `limit + 1` on every stream, so it means "there is older history"
 * and not "one stream filled its page". The app's own version cannot say that with
 * certainty: it means "older blocks not walked yet or rows found and not shown".
 */
app.get("/points/history", async (c) => {
  const chainId = chainOf(c);
  const net = chainsIndexed().get(chainId);
  if (!net) return c.json(notIndexed(chainId), 404);

  const address = addressOf(c.req.query("address"));
  if (!address) return c.json({ error: "address required" }, 400);

  const limit = bounded(c.req.query("limit"), HISTORY_LIMIT, 200);
  const over = limit + 1;

  const [own, referred, created, traded, granted] = await Promise.all([
    db
      .select()
      .from(registration)
      .where(and(eq(registration.chainId, chainId), eq(registration.who, address)))
      .limit(1),
    db
      .select()
      .from(registration)
      .where(and(eq(registration.chainId, chainId), eq(registration.referrer, address)))
      .orderBy(desc(registration.blockNumber), desc(registration.logIndex))
      .limit(over),
    db
      .select({
        address: token.address,
        symbol: token.symbol,
        createdAt: token.createdAt,
        blockNumber: token.createdBlock,
        logIndex: token.createdLogIndex,
        txHash: token.createdTx,
      })
      .from(token)
      .where(and(eq(token.chainId, chainId), eq(token.creator, address)))
      .orderBy(desc(token.createdBlock), desc(token.createdLogIndex))
      .limit(over),
    db
      .select()
      .from(trade)
      .where(and(eq(trade.chainId, chainId), eq(trade.trader, address)))
      .orderBy(desc(trade.blockNumber), desc(trade.logIndex))
      .limit(over),
    db
      .select()
      .from(pointGrant)
      .where(and(eq(pointGrant.chainId, chainId), eq(pointGrant.who, address)))
      .orderBy(desc(pointGrant.blockNumber), desc(pointGrant.logIndex))
      .limit(over),
  ]);

  type Event = {
    kind: string;
    block: bigint;
    logIndex: number;
    txHash: string;
    at: number;
    token?: string;
    symbol?: string;
    referee?: string;
    isBuy?: boolean;
    venue?: string;
    amount?: bigint;
    reason?: string;
  };

  const events: Event[] = [];

  for (const r of own) {
    events.push({
      kind: "register",
      block: r.blockNumber,
      logIndex: r.logIndex,
      txHash: r.txHash,
      at: r.at,
    });
  }
  for (const r of referred) {
    events.push({
      kind: "referral",
      block: r.blockNumber,
      logIndex: r.logIndex,
      txHash: r.txHash,
      at: r.at,
      referee: r.who,
    });
  }
  for (const r of created) {
    events.push({
      kind: "create",
      block: r.blockNumber,
      logIndex: r.logIndex,
      txHash: r.txHash,
      at: r.createdAt,
      token: r.address,
      symbol: r.symbol,
    });
  }
  for (const r of traded) {
    events.push({
      kind: "trade",
      block: r.blockNumber,
      logIndex: r.logIndex,
      txHash: r.txHash,
      at: r.timestamp,
      token: r.token,
      isBuy: r.isBuy,
      venue: r.source,
    });
  }
  for (const r of granted) {
    events.push({
      kind: r.kind,
      block: r.blockNumber,
      logIndex: r.logIndex,
      txHash: r.txHash,
      at: r.timestamp,
      amount: r.amount,
      ...(r.reason === null ? {} : { reason: r.reason }),
    });
  }

  events.sort((a, b) =>
    a.block === b.block
      ? b.logIndex - a.logIndex
      : a.block > b.block
        ? -1
        : 1,
  );

  const page = events.slice(0, limit);

  // Tickers for the trade rows, in one query over the addresses actually on this page.
  // The `create` rows already carry theirs — they *are* token rows — and looking those up
  // again would be a join against the table they came from.
  const wanted = [
    ...new Set(
      page.filter((e) => e.kind === "trade" && e.token).map((e) => e.token as string),
    ),
  ];

  if (wanted.length > 0) {
    const rows = await db
      .select({ address: token.address, symbol: token.symbol })
      .from(token)
      .where(
        and(eq(token.chainId, chainId), inArray(token.address, wanted as `0x${string}`[])),
      );
    const bySymbol = new Map(rows.map((r) => [r.address.toLowerCase(), r.symbol]));
    for (const e of page) {
      if (e.kind !== "trade" || !e.token) continue;
      const symbol = bySymbol.get(e.token.toLowerCase());
      if (symbol) e.symbol = symbol;
    }
  }

  return c.json(
    serialise({
      chainId,
      startBlock: String(net.startBlock),
      events: page,
      more: events.length > limit,
    }),
  );
});

export default app;
