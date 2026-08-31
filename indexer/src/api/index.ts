import { db } from "ponder:api";
import schema from "ponder:schema";
import { candle, protocolFee, token, trade } from "ponder:schema";
import { and, asc, client, desc, eq, graphql, gte, sql, sum } from "ponder";
import { Hono } from "hono";

/**
 * The three routes the app currently derives from RPC, as queries.
 *
 * These exist to prove the point of the whole package rather than to be the final
 * API surface: each one is the exact answer an existing route in `web/app/api/`
 * assembles from contract reads and log scans, expressed as SQL over rows that were
 * already final when the block landed.
 *
 * Deliberately shaped like the payloads the app already consumes, so the migration is
 * a change of `fetch` URL inside `lib/stats.ts` and `lib/hooks.ts` rather than a
 * rewrite of the components reading them. `bigint` is serialised as a decimal string
 * for the same reason: that is what the current routes send, and what `lib/scans.ts`
 * parses back with `BigInt(...)`.
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

const chainOf = (c: { req: { query: (k: string) => string | undefined } }) =>
  Number(c.req.query("chain") ?? 57073);

/**
 * The market list — what `/api/market` reads with `MARKET_LIMIT × PER_LISTING`
 * contract calls per three-second window.
 *
 * The interesting part is not that it is one query, it is `sort` and `offset`: the
 * current route has neither, because both need every launch's figures to exist before
 * you can order by them, and it only has the hundred it decided to read. Here the cap
 * is a page size.
 */
app.get("/market", async (c) => {
  const chainId = chainOf(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const order = {
    new: desc(token.createdAt),
    cap: desc(token.marketCapWei),
    volume: desc(token.volumeWei),
    active: desc(token.lastTradeAt),
  }[c.req.query("sort") ?? "new"] ?? desc(token.createdAt);

  const rows = await db
    .select()
    .from(token)
    .where(eq(token.chainId, chainId))
    .orderBy(order)
    .limit(limit)
    .offset(offset);

  return c.json(serialise({ chainId, listings: rows }));
});

/**
 * Rolling-window volume, fees and per-launch opens — the whole of `/api/volume`.
 *
 * Worth comparing with what it replaces. That route walks about ten chunked
 * `eth_getLogs` per chain, twice over (curve events and pair events), into a
 * module-scope `Map` that is rebuilt on every cold lambda in every region; the window
 * it reports is whatever it managed to scan. This is three predicates on an index, and
 * `seconds` is exactly 86,400 because the boundary is a number rather than a scan
 * depth.
 *
 * `opens` is the 24-hour reference price the market cards divide against — the same
 * shape `Day.opens` has in web/lib/scans.ts, keyed by lowercased address, absent rather
 * than zero when a launch has not traded in the window. Postgres' `DISTINCT ON` gets the
 * first fill per token in one pass, and it is spelled through the query builder rather
 * than as a `sql` template on purpose: Ponder runs drizzle with `casing: "snake_case"`,
 * whose rule turns `priceE18` into `price_e_18` and not the `price_e18` a person would
 * type. Column names written by hand are the one thing in this file that `tsc` cannot
 * check, so none are.
 */
app.get("/volume", async (c) => {
  const chainId = chainOf(c);
  const seconds = Math.min(Number(c.req.query("seconds") ?? 86_400), 7 * 86_400);
  const since = Math.floor(Date.now() / 1000) - seconds;

  const [totals] = await db
    .select({
      volumeWei: sum(trade.ethAmount).mapWith(String),
      trades: sql<number>`count(*)::int`,
    })
    .from(trade)
    .where(and(eq(trade.chainId, chainId), gte(trade.timestamp, since)));

  const [fees] = await db
    .select({ feeWei: sum(protocolFee.amountWei).mapWith(String) })
    .from(protocolFee)
    .where(and(eq(protocolFee.chainId, chainId), gte(protocolFee.timestamp, since)));

  const opens = await db
    .selectDistinctOn([trade.token], { token: trade.token, price: trade.priceE18 })
    .from(trade)
    .where(and(eq(trade.chainId, chainId), gte(trade.timestamp, since)))
    .orderBy(trade.token, asc(trade.timestamp));

  return c.json({
    chainId,
    day: {
      seconds,
      volumeWei: totals?.volumeWei ?? "0",
      trades: totals?.trades ?? 0,
      feeWei: fees?.feeWei ?? "0",
      opens: Object.fromEntries(
        opens.map((r) => [r.token.toLowerCase(), r.price.toString()]),
      ),
    },
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
