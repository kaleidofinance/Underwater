import { index, onchainTable, primaryKey, relations } from "ponder";

/**
 * The shape the app reads instead of scanning logs.
 *
 * Every table here exists to answer a question one of the API routes currently
 * answers with RPC calls at request time. The point of the whole indexer is that the
 * answers survive: `/api/market` re-reads four contract fields per launch every three
 * seconds, and `/api/volume` walks a day of `eth_getLogs` into a `Map` that dies with
 * the lambda instance. Both are re-derivations of facts that were already final when
 * the block landed.
 *
 * Two conventions run through all of it:
 *
 *  - **Chain id is part of every primary key.** The same token address cannot occur on
 *    two chains, but a launchpad deployed to four networks produces four independent
 *    histories, and a row that did not say which one it belonged to would silently
 *    merge them. The app already keys everything this way — `chainFrom` in
 *    lib/server-rpc.ts makes the chain an explicit parameter for the same reason.
 *  - **Derived columns are stored, not computed on read.** `priceE18`, `marketCapWei`
 *    and `progressBps` are written by the handler that changed the reserves, using the
 *    functions in web/lib/curve.ts. Storing them is what lets the market list be a
 *    single `ORDER BY` instead of a hundred rows fed through a transform — which is
 *    the entire reason `MARKET_LIMIT = 100` exists today.
 */

/**
 * One row per launch, holding its current state.
 *
 * The `token` row is what `/api/market` becomes: a `SELECT … ORDER BY` over rows that
 * are already up to date, rather than `MARKET_LIMIT × PER_LISTING` contract reads. It
 * carries both halves of a launch's life — the curve reserves while it is on the
 * curve, and the pair link after it graduates — because the app shows one list and
 * does not care which side of graduation a launch is on.
 *
 * `graduationEth` and `totalSupply` are stored per token rather than hard-coded as
 * constants. They are `constant` in the contract, so they cannot change for a given
 * launchpad — but they are read from the launchpad that actually emitted the event, so
 * a differently-parameterised deploy on another chain indexes correctly instead of
 * being measured against numbers copied from this repo's Solidity. That is the same
 * discipline `CURVE` in web/lib/contracts.ts consciously trades away for a round trip,
 * and the trade is free here: it is read once per launch, not once per render.
 */
export const token = onchainTable(
  "token",
  (t) => ({
    chainId: t.integer().notNull(),
    address: t.hex().notNull(),
    creator: t.hex().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    metadataUri: t.text().notNull(),
    createdAt: t.integer().notNull(),
    createdBlock: t.bigint().notNull(),

    // Curve state, as of the most recent `Trade`. Frozen at graduation, and kept
    // rather than overwritten: the curve is the launch's early history and a chart
    // that started at graduation would be lying about where the price came from.
    ethReserve: t.bigint().notNull(),
    tokenReserve: t.bigint().notNull(),
    realEthRaised: t.bigint().notNull(),

    graduated: t.boolean().notNull(),
    graduatedAt: t.integer(),
    /** The pair, once there is one. Null is the ordinary state, not a missing value. */
    pair: t.hex(),

    // The launchpad's own constants, read from the launchpad that emitted the event.
    graduationEth: t.bigint().notNull(),
    totalSupply: t.bigint().notNull(),

    // Derived, and maintained by whichever handler last moved the price — `Trade`
    // while on the curve, `Sync` after graduation. One column either way, so the
    // market list never has to know which source is live.
    priceE18: t.bigint().notNull(),
    marketCapWei: t.bigint().notNull(),
    progressBps: t.integer().notNull(),

    // All-time counters, incremented in place. Cheap here and impossible in the
    // current design: an all-time total is the one figure a windowed log scan can
    // never produce, which is why /api/volume has an `allTime` that means
    // "since this instance started".
    tradeCount: t.integer().notNull(),
    volumeWei: t.bigint().notNull(),
    feeWei: t.bigint().notNull(),
    lastTradeAt: t.integer(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] }),
    // The market list's sorts. Newest-first is the default the app opens on; the
    // other two are the sorts it cannot currently offer at all.
    byAge: index().on(table.chainId, table.createdAt),
    byCap: index().on(table.chainId, table.marketCapWei),
    byVolume: index().on(table.chainId, table.volumeWei),
    byCreator: index().on(table.chainId, table.creator),
  }),
);

/**
 * Every fill, from either venue, in one shape.
 *
 * This is the table that collapses `/api/volume`. That route reads curve `Trade` logs
 * and pair `Swap` logs separately, normalises them, and unions the result — because
 * they are two different events on two different contracts describing the same thing.
 * Normalising once at index time instead means 24-hour volume is
 * `SUM(eth_amount) WHERE timestamp > …`, the 24-hour open is `ORDER BY timestamp ASC
 * LIMIT 1`, and the trade feed is `ORDER BY timestamp DESC LIMIT 50`. No scan, no
 * chunking, no per-instance store.
 *
 * `source` keeps the distinction the app still wants to show — a curve buy and a pool
 * swap are different actions to a trader even when they are the same row here.
 *
 * `priceE18` is the price *after* the fill, which is the convention the `Trade` event
 * already uses by carrying its resulting reserves. Pool swaps get the same treatment
 * for free: `Sync` is emitted before `Swap` in the same transaction, so the pair row
 * already holds post-swap reserves by the time the `Swap` handler runs.
 */
export const trade = onchainTable(
  "trade",
  (t) => ({
    /** `${chainId}-${blockNumber}-${logIndex}`, which is unique by construction. */
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    trader: t.hex().notNull(),
    /** `"curve"` or `"pool"`. */
    source: t.text().notNull(),
    isBuy: t.boolean().notNull(),
    ethAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),
    /** The protocol's cut, in wei. Zero for a pool swap — see `protocolFee`. */
    feeWei: t.bigint().notNull(),
    priceE18: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    // The 24-hour window, per token and market-wide. Both are the same query shape
    // with and without a token predicate, which is why the composite leads with
    // chain and token but the market-wide index exists separately.
    byToken: index().on(table.chainId, table.token, table.timestamp),
    byTime: index().on(table.chainId, table.timestamp),
    byTrader: index().on(table.chainId, table.trader, table.timestamp),
  }),
);

/**
 * A graduated launch's pool, and its reserves.
 *
 * Exists as its own row rather than as columns on `token` because a pair's reserves
 * move on liquidity events as well as swaps, and because of an ordering fact worth
 * being explicit about: the pair's `Mint` and `Sync` are emitted *before* the
 * launchpad's `Graduated` in the same transaction, since the launchpad adds liquidity
 * and then announces it. Ponder discovers the pair from `Graduated` and indexes the
 * same block, so the first `Sync` for a pair can arrive before the row that says which
 * token it belongs to.
 *
 * Hence nullable `token` and `wethIsToken0`: `Sync` upserts reserves unconditionally,
 * `Graduated` fills in the link. A handler that finds the link missing skips the
 * token-side update and loses nothing, because `Graduated` sets the opening pool price
 * from its own arguments anyway.
 *
 * `wethIsToken0` is settled once, by reading `token0()` at graduation. The pair holds
 * exactly WETH and the launch's token, so whichever side is not the token is WETH —
 * which means the WETH address never has to be configured here.
 */
export const pair = onchainTable(
  "pair",
  (t) => ({
    chainId: t.integer().notNull(),
    address: t.hex().notNull(),
    token: t.hex(),
    wethIsToken0: t.boolean(),
    reserve0: t.bigint().notNull(),
    reserve1: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] }),
    byToken: index().on(table.chainId, table.token),
  }),
);

/**
 * OHLCV, aggregated as the trades arrive.
 *
 * The reason to have this rather than deriving candles from `trade` on read: a chart
 * asks for a fixed number of buckets over a long window, and `GROUP BY` over every
 * fill in that window is the one query in this schema that grows without bound. A
 * candle row is written once per bucket per interval and read forever.
 *
 * Intervals are stored as a column rather than split into a table each, so adding a
 * fourth timeframe is a constant in the handler and not a migration.
 *
 * Note what this replaces: the price track in `/api/volume` reconstructs a day of
 * prices from the same logs on every cold instance, at a grain chosen to keep the
 * payload small. Here the grain is the query's to choose.
 */
export const candle = onchainTable(
  "candle",
  (t) => ({
    /** `${chainId}-${token}-${interval}-${bucketStart}`. */
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    token: t.hex().notNull(),
    /** Bucket width in seconds. */
    interval: t.integer().notNull(),
    /** Unix seconds, floored to `interval`. */
    bucket: t.integer().notNull(),
    open: t.bigint().notNull(),
    high: t.bigint().notNull(),
    low: t.bigint().notNull(),
    close: t.bigint().notNull(),
    volumeWei: t.bigint().notNull(),
    trades: t.integer().notNull(),
  }),
  (table) => ({
    byToken: index().on(table.chainId, table.token, table.interval, table.bucket),
  }),
);

/**
 * The revenue ledger — one row per event that earned the protocol something.
 *
 * Four legs, because there are four ways this protocol takes a fee, and the market's
 * fee figure means all of them: `creation` on every launch, `trade` on every curve
 * fill, `graduation` on the raise moving to the pool, and `swap` for the DEX's own
 * feeTo share. Writing them as rows rather than as running totals is what makes
 * "revenue in the last 24 hours" and "revenue since launch" the same query with a
 * different predicate.
 *
 * `swap` is not yet written by any handler. The pair accrues the protocol's sixth of
 * its 0.3% into LP tokens minted to `feeTo` at the next liquidity event, so it is not
 * an amount that appears in a log — it has to be computed from the k-invariant growth
 * between `Mint`/`Burn` events, and it is inert anyway while the graduation LP is
 * burned and `feeTo`'s claim never mints. Left as a documented gap rather than a
 * wrong number: see `feeToFor` in web/lib/server-dex.ts, which throws rather than
 * guessing for the same reason.
 */
export const protocolFee = onchainTable(
  "protocol_fee",
  (t) => ({
    /** `${chainId}-${blockNumber}-${logIndex}-${kind}`. */
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    /** `"creation"`, `"trade"`, `"graduation"`, or `"swap"`. */
    kind: t.text().notNull(),
    /** The launch it came from. Every leg is attributable to one. */
    token: t.hex().notNull(),
    amountWei: t.bigint().notNull(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    byTime: index().on(table.chainId, table.timestamp),
    byKind: index().on(table.chainId, table.kind, table.timestamp),
    byToken: index().on(table.chainId, table.token),
  }),
);

/**
 * `token` ← `trade`, `candle`, `protocolFee`, and `token` ↔ `pair`.
 *
 * Declared only so the generated GraphQL exposes the nesting a token page wants in one
 * query. Nothing in the handlers depends on these; they are a read-side convenience,
 * and the SQL-over-HTTP path joins on the columns directly.
 *
 * Every `many` below needs the matching `one` declared on the other side, or building
 * the GraphQL schema fails outright with `Relation "candles" not found in table
 * "candle"`. A `one` with explicit `fields`/`references` stands alone — which is why
 * `pool` needs nothing added to `pair`.
 */
export const tokenRelations = relations(token, ({ many, one }) => ({
  trades: many(trade),
  candles: many(candle),
  fees: many(protocolFee),
  pool: one(pair, {
    fields: [token.chainId, token.pair],
    references: [pair.chainId, pair.address],
  }),
}));

export const tradeRelations = relations(trade, ({ one }) => ({
  launch: one(token, {
    fields: [trade.chainId, trade.token],
    references: [token.chainId, token.address],
  }),
}));

export const candleRelations = relations(candle, ({ one }) => ({
  launch: one(token, {
    fields: [candle.chainId, candle.token],
    references: [token.chainId, token.address],
  }),
}));

export const protocolFeeRelations = relations(protocolFee, ({ one }) => ({
  launch: one(token, {
    fields: [protocolFee.chainId, protocolFee.token],
    references: [token.chainId, token.address],
  }),
}));
