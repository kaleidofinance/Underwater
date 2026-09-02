import { index, onchainTable, primaryKey, relations } from "ponder";

/**
 * The shape the app reads instead of scanning logs.
 *
 * Every table here exists to answer a question one of the API routes currently
 * answers with RPC calls at request time. The point of the whole indexer is that the
 * answers survive: `/api/market` re-reads four contract fields per launch every three
 * seconds, `/api/volume` walks a day of `eth_getLogs` into a `Map` that dies with
 * the lambda instance, and `/api/points` walks *all of history* on five log streams to
 * price one wallet. All three are re-derivations of facts that were already final when
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
    /**
     * Where the launch was announced, so a points history row can link to it.
     *
     * `createdBlock` alone cannot order a creation against a trade in the same block,
     * and a `create` entry in the points feed with no transaction to open is the one
     * row in that list a user cannot check.
     */
    createdTx: t.hex().notNull(),
    createdLogIndex: t.integer().notNull(),

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
    // One index per ordering the market list offers, because a sort without one is a
    // sequential scan of the chain's whole market to return twenty-four rows — free at
    // this size and the wrong shape to grow into. `lastTradeAt` is nullable, so its
    // index carries the nulls the `active` sort pushes to the end.
    byAge: index().on(table.chainId, table.createdAt),
    byCap: index().on(table.chainId, table.marketCapWei),
    byVolume: index().on(table.chainId, table.volumeWei),
    byProgress: index().on(table.chainId, table.progressBps),
    byActivity: index().on(table.chainId, table.lastTradeAt),
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
    /**
     * Who sent the transaction, which on a pool sell is not `trader`.
     *
     * `trader` is `msg.sender` on a curve fill and `Swap.to` on a pool one, and the
     * second is the *router* whenever the output has to be unwrapped — so a sell would
     * otherwise attribute itself to a contract. The trade feed needs a person, so it
     * reads this for pool rows; `/points` deliberately keeps reading `trader`, because
     * `isTrader` already refuses to credit a contract and changing which address earns a
     * point is a different decision from fixing which address a row is labelled with.
     *
     * Its own column rather than a resolution done here, for that reason: two consumers
     * want two different answers about the same row and both are right.
     */
    txFrom: t.hex().notNull(),
    /** `"curve"` or `"pool"`. */
    source: t.text().notNull(),
    isBuy: t.boolean().notNull(),
    ethAmount: t.bigint().notNull(),
    tokenAmount: t.bigint().notNull(),
    /** The protocol's cut, in wei. Zero for a pool swap — see `protocolFee`. */
    feeWei: t.bigint().notNull(),
    priceE18: t.bigint().notNull(),
    /**
     * ETH the curve was holding after this fill — `Trade.realEthRaised`, and null on a
     * pool swap, which is not a curve and holds no raise.
     *
     * A per-fill copy of a number the `token` row also carries at its latest value, and
     * the duplication is the point: the row says what the curve holds *now*, this says
     * what it held then, and a progress bar beside a historical trade wants the second.
     * Cannot be derived from the fills either — it is net of fees, so summing
     * `ethAmount` overstates it, and graduation zeroes it outright.
     */
    raised: t.bigint(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    /**
     * The log's position in its block.
     *
     * Already half of `id`, and kept as a column because two things need to sort by it.
     * The points history merges five streams into one descending feed, and `(block,
     * logIndex)` is the only total order over logs that a timestamp cannot give — a
     * 0.1-second chain puts several blocks in the same second, and `opensIn` fell back
     * to block number for exactly this reason. `/api/points/history` also dedupes on
     * `${txHash}:${logIndex}`, so serving it from here means the key survives the swap.
     */
    logIndex: t.integer().notNull(),
  }),
  (table) => ({
    // The 24-hour window, per token and market-wide. Both are the same query shape
    // with and without a token predicate, which is why the composite leads with
    // chain and token but the market-wide index exists separately.
    byToken: index().on(table.chainId, table.token, table.timestamp),
    byTime: index().on(table.chainId, table.timestamp),
    // One launch's feed, newest first — and ordered by position on the chain rather than
    // by the clock, which is why it is not `byToken` with a different direction. Two fills
    // in the same second are ordered by `(blockNumber, logIndex)` and by nothing else, and
    // on a one-second chain that is not a rare case; the RPC scan this serves sorts the
    // same way, so a timestamp ordering here would hand back the same rows in a different
    // order from the fallback path.
    byTokenBlock: index().on(table.chainId, table.token, table.blockNumber),
    // A wallet's own fills, newest first — the trade half of the points history, and
    // the reason this leads with `blockNumber` rather than `timestamp` like the two
    // above it: the feed is ordered by `(blockNumber, logIndex)`, so an index on the
    // timestamp would be read and then re-sorted.
    byTrader: index().on(table.chainId, table.trader, table.blockNumber),
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
 * What a wallet has *done*, per chain — the counts a uwPoints balance is priced from.
 *
 * The single most important thing about this table is what it does not hold: a balance.
 * `UnderwaterPoints` stores only a rate card and a `granted` mapping, and a balance is
 * `rates × counts + granted` computed on every read, so changing a rate re-prices all
 * of history. Storing points here would make that a lie the moment the owner moved a
 * rate — the indexer would be serving yesterday's prices at today's rate card. So the
 * counts are indexed, the rates are read from the chain at request time, and the
 * multiplication happens exactly where it happens now, in `pointsFrom` in
 * web/lib/points.ts.
 *
 * The counts themselves are the aggregate of five log streams that `/api/points`
 * currently walks from `POINTS_FROM_BLOCK` to head on every cold read: `Registered`
 * twice over (once as a registration, once as the referrer's credit), `TokenCreated`,
 * curve `Trade`, and pool `Swap`. Incrementing them as the logs arrive is the second
 * convention above applied to the one route where the scan is unbounded — the others
 * degrade with a 24-hour window, this one degrades with the age of the deployment.
 *
 * `granted` is the sum of `Redeemed` and `Granted` amounts, which reproduces the
 * contract's `granted[who]` mapping exactly: it is cumulative and never decremented,
 * so a sum over history and a mapping read are the same number. It is still read from
 * the chain as a cross-check rather than trusted blindly — see `/points` in
 * src/api/index.ts.
 *
 * A row exists because something happened, so `SELECT count(*)` over a chain is the
 * participant count, and there are no all-zero rows padding it.
 */
export const account = onchainTable(
  "account",
  (t) => ({
    chainId: t.integer().notNull(),
    address: t.hex().notNull(),

    /**
     * The waitlist facts, mirrored here so the leaderboard is one table.
     *
     * `registered` is not `position !== null`: a chain with a points contract and no
     * waitlist (Robinhood) has accounts that trade and never register, and the sort
     * order puts unregistered wallets last rather than treating them as position zero.
     * `position` is the 1-based arrival order the `Registered` event carries, and it is
     * the leaderboard's tie-break — two wallets on identical points are ranked by who
     * turned up first, which is a fact and not a coin toss.
     */
    registered: t.boolean().notNull(),
    position: t.bigint(),
    registeredAt: t.integer(),
    /** Who referred them, if anyone. Null and the zero address are both "nobody". */
    referrer: t.hex(),

    /**
     * Every stream's count, in the units the rate card prices.
     *
     * `referrals` is the raw count of wallets naming this one as referrer, which is
     * deliberately *not* the number the balance card shows: the app gates a referral on
     * the referred wallet having done something on-chain since (`web/lib/activity.ts`),
     * and that check needs a nonce and two positions on other chains — state, not logs,
     * and so not indexable here. The gap is bounded by `rates.referral × referrals` and
     * is documented at every point it can be seen. See `/points` in src/api/index.ts.
     */
    referrals: t.integer().notNull(),
    creates: t.integer().notNull(),
    /** Curve fills and pool swaps together, which is what `rates.swap` prices. */
    trades: t.integer().notNull(),

    /** `Redeemed` + `Granted`, summed. The contract's `granted[who]`. */
    granted: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.address] }),
    /**
     * The whole chain's accounts, which is what a rank costs.
     *
     * A rank is `count(*) WHERE score > mine` with the rate card interpolated, and no
     * index can serve that predicate — the score is an expression over four columns
     * that changes when the owner moves a rate, so there is nothing stable to index.
     * What this does buy is the row restriction: the count scans one chain's accounts
     * rather than every chain's. That is a bounded sequential scan and the honest
     * trade — the alternative the app has today is materialising the entire
     * leaderboard in a lambda, which is what `BOARD_LIMIT = 20_000` is a surrender to.
     */
    byChain: index().on(table.chainId),
  }),
);

/**
 * One row per waitlist registration, kept for the two things the aggregate cannot say.
 *
 * `account` holds a referral *count*; this holds the edges, so "who did I refer" is a
 * query rather than a scan, and it holds the block and log index that put a registration
 * in its place in the points history feed. Both are things `/api/points` reconstructs
 * from an unfiltered `Registered` scan today, because the referrer is an indexed topic
 * but the referred wallet's own registration is the row that carries the timestamp.
 *
 * Keyed by `who` and not by log position: the waitlist reverts on a second registration
 * from the same address, so a wallet has at most one of these, and a primary key that
 * says so is worth more than one that permits a state the contract does not.
 */
export const registration = onchainTable(
  "registration",
  (t) => ({
    chainId: t.integer().notNull(),
    who: t.hex().notNull(),
    /** 1-based arrival order, carried in the log rather than counted here. */
    position: t.bigint().notNull(),
    /** The contract's own `at`, which is the block timestamp it was written in. */
    at: t.integer().notNull(),
    /** Null where the log carried the zero address — registration without a referral. */
    referrer: t.hex(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.chainId, table.who] }),
    /** A referrer's downline, newest first — the referral half of the history feed. */
    byReferrer: index().on(table.chainId, table.referrer, table.blockNumber),
    /** Arrival order, for the leaderboard's tie-break and for the waitlist itself. */
    byPosition: index().on(table.chainId, table.position),
  }),
);

/**
 * Points handed out rather than earned — coupon redemptions and direct grants.
 *
 * Two events with one shape, because they are the same fact to a balance: `Redeemed`
 * carries a `codeHash` and `Granted` carries a `reason` string, and both add to the
 * contract's `granted` mapping. `kind` keeps them apart for the history feed, where a
 * redeemed coupon and an awarded grant are different things to read.
 *
 * `amount` is stored per row even though only the sum is ever priced, because the sum is
 * already on `account.granted` — this table exists for the feed, and a feed entry
 * without its amount is not one.
 *
 * Not indexed from the rate card: `RatesUpdated`, `CouponIssued` and `CouponVoided` are
 * deliberately absent. The rate card is read from the chain at request time (see
 * `account` above) and coupon state is only meaningful to the wallet trying to redeem
 * one, which the app asks the contract directly.
 */
export const pointGrant = onchainTable(
  "point_grant",
  (t) => ({
    /** `${chainId}-${blockNumber}-${logIndex}`. */
    id: t.text().primaryKey(),
    chainId: t.integer().notNull(),
    who: t.hex().notNull(),
    /** `"coupon"` for `Redeemed`, `"grant"` for `Granted`. */
    kind: t.text().notNull(),
    amount: t.bigint().notNull(),
    /** The coupon's hash, for a `coupon` row. The code itself is never on-chain. */
    codeHash: t.hex(),
    /** The grant's stated reason, for a `grant` row. Free text from the owner. */
    reason: t.text(),
    timestamp: t.integer().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    byWho: index().on(table.chainId, table.who, table.blockNumber),
  }),
);

/**
 * `token` ← `trade`, `candle`, `protocolFee`, `token` ↔ `pair`, and `account` ↔ its rows.
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

export const accountRelations = relations(account, ({ many, one }) => ({
  /** The waitlist row, where there is one. Null for a wallet that only traded. */
  enrolment: one(registration, {
    fields: [account.chainId, account.address],
    references: [registration.chainId, registration.who],
  }),
  grants: many(pointGrant),
}));

// One `one` per table pair and no more. The referral edge is the more interesting
// direction to traverse, but `registration.referrer` and `registration.who` both point
// at `account`, and a second relation between the same two tables needs naming on both
// sides to stay unambiguous — not worth it for a convenience layer nothing reads. The
// downline is `byReferrer`, in SQL.
export const registrationRelations = relations(registration, ({ one }) => ({
  account: one(account, {
    fields: [registration.chainId, registration.who],
    references: [account.chainId, account.address],
  }),
}));

export const pointGrantRelations = relations(pointGrant, ({ one }) => ({
  account: one(account, {
    fields: [pointGrant.chainId, pointGrant.who],
    references: [account.chainId, account.address],
  }),
}));
