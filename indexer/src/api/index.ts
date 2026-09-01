import { db } from "ponder:api";
import schema from "ponder:schema";
import { candle, protocolFee, token, trade } from "ponder:schema";
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
let indexed: Map<number, { launchpad: string; startBlock: number }> | undefined;

function chainsIndexed() {
  if (!indexed) {
    indexed = new Map(
      configuredNetworks().map((net) => [
        net.id,
        { launchpad: net.launchpad, startBlock: net.startBlock },
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
    chains: [...chainsIndexed()].map(([chainId, { launchpad, startBlock }]) => ({
      chainId,
      launchpad,
      startBlock: String(startBlock),
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
 * same second are ordered by block, since the schema keeps no log index of its own.
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
      .orderBy(trade.token, desc(trade.timestamp), desc(trade.blockNumber)),
    db
      .selectDistinctOn([trade.token], { token: trade.token, price: trade.priceE18 })
      .from(trade)
      .where(and(onPage, gte(trade.timestamp, since)))
      .orderBy(trade.token, asc(trade.timestamp), asc(trade.blockNumber)),
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

export default app;
