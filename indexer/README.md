# indexer

A [Ponder](https://ponder.sh) app that reads the launchpad's and the DEX's logs once
and writes them to Postgres, so the web app can stop re-deriving the market from RPC
on every request.

## Why this exists

Every number the market shows is currently computed at request time:

- **`web/app/api/market/route.ts`** reads `MARKET_LIMIT` (100) launches ×
  `PER_LISTING` (4) contract fields, batched into a handful of multicalls, once per
  three-second cache window per edge region.
- **`web/app/api/volume/route.ts`** walks a day of `eth_getLogs` — about ten chunks per
  chain, twice over for curve events and pair events — into a module-scope `Map` that
  lives and dies with the lambda instance. Every cold instance rescans the day.

That works, and it is not the RPC bill that breaks it. What breaks is that
`MARKET_LIMIT = 100` is a cap on the *answer*, not on the data: past a hundred launches
the market can only show the newest hundred, and it can never offer "sort by market cap
across the market", "most traded", search, or pagination, because ordering by any of them
needs every launch's figures to exist before you can compare two of them. The log scan
also grows with the number of *pairs* rather than with the window, so it gets slower as
launches accumulate even for a fixed day.

Indexing inverts it. One forward-only process reads each event once, and the questions
become queries:

| Question | Today | Here |
| --- | --- | --- |
| Market list | 400 `eth_call` per window | `SELECT … ORDER BY … LIMIT` |
| 24h volume | ~20 `eth_getLogs` per cold instance | `SUM(eth_amount) WHERE timestamp > …` |
| 24h open per launch | first `Trade` found in the scanned window | `DISTINCT ON (token) … ORDER BY timestamp` |
| Protocol fees | scan + four separate derivations | `SUM(amount_wei) GROUP BY kind` |
| Candles | reconstructed per request at a fixed grain | one row per bucket, written once |
| uwPoints balance | five `eth_getLogs` streams over all history | five counters on a row |
| uwPoints rank | a 20,000-row leaderboard built in memory | `count(*) WHERE score > mine` |
| One wallet's history | seven filters walked backwards under a 7s clock | four indexed reads |
| All-time totals | *not possible* — a window scan has no "all time" | a column |

## Design notes worth knowing before reading the code

**Pairs are discovered from `Graduated`, not from the DEX factory.** The launchpad emits
`Graduated(address indexed token, address indexed pair, …)`, which names the pool
explicitly. That makes it a better factory event than `UnderwaterFactory`'s own
`PairCreated`: the factory is a public AMM and anybody may create a pair on it, so
`PairCreated` would enrol pools unrelated to any launch and then need filtering back
out. It also means no factory or WETH address has to be configured here at all —
`wethIsToken0` is settled by one `token0()` read per graduation, since the pair holds
exactly WETH and the launch's token.

**The hot path makes no RPC requests.** `Trade` carries the reserves it left behind (the
contract says so, in a comment above the event), so price, market cap and progress come
out of the log. Only `TokenCreated` and `Graduated` read anything, and both happen once
per launch.

**`Sync` arrives before `Graduated`.** The launchpad adds liquidity and *then* announces
the graduation, in one transaction, and Ponder indexes the discovered pair from that
same block. So the pair's first `Sync` can land before the row saying which launch it
belongs to. `pair.token` is nullable for exactly that reason and the handlers tolerate
the gap; `Graduated` fills it in and sets the opening pool price from its own arguments.

**The curve maths is imported, not restated.** `src/curve.ts` re-exports
`web/lib/curve.ts`, which has zero imports of its own. A stored market cap and a
rendered one are then the same division. Reaching across a package boundary with a
relative path is uglier than a workspace would be, and much better than two copies.

**`graduationEth` and `totalSupply` are read from the launchpad, per launch.** They are
`constant` in the contract, so a process-lifetime memo is sound — but they come from the
launchpad that emitted the event rather than from constants copied out of this repo's
Solidity, so a differently-parameterised deploy indexes correctly.

**`TokenCreated` reads state, so a chain needs an archive endpoint.** This is the one
requirement that is not obvious from the config, and it is what stops Robinhood Testnet
being indexed from its deploy block today — see "Chains that need an archive RPC" below.

**uwPoints stores counts, never points.** `UnderwaterPoints` deliberately holds no
balance: it holds a rate card, and a balance is that card multiplied by counts of logs,
recomputed on every read. So a rate change re-prices all of history — which is a feature,
and it is also why a stored `points` column here would be a number that silently went
stale. The `account` table counts registrations, referrals, launches and trades; the rate
card is read from the chain at request time, by the app, from the same memo it already
used. See `ponder.schema.ts` for the long version.

**The `swap` fee leg is a documented gap.** The pool's protocol share accrues as LP
tokens minted to `feeTo` at the next liquidity event, which appears in no log, and is
inert anyway while the graduation LP is burned. It is left unwritten rather than
estimated — the same call `feeToFor` in `web/lib/server-dex.ts` already makes by throwing
instead of guessing.

## Running it against anvil

Needs no Postgres — with `DATABASE_URL` unset, Ponder uses PGlite under `.ponder/`.

```bash
cd web && npm run localchain
```

That writes `NEXT_PUBLIC_LAUNCHPAD_ANVIL` into `web/.env.local` and puts a few launches
on the local chain. Then:

```bash
cd indexer && cp ../web/.env.local .env.local && npm install && npm run dev
```

The env names line up on purpose, so the copy is the whole configuration step. `ponder
dev` serves the three routes in `src/api/index.ts` on port 42069, plus GraphQL at
`/graphql` and SQL-over-HTTP at `/sql/*` — both mounted explicitly in that file, because
Ponder does not mount either for you.

```bash
curl "http://localhost:42069/market?chain=31337&sort=volume"
```

Against the seeded chain that returns five launches with the graduated one first, and
`/volume` reports eight trades, 10.0885 ETH of volume and 0.30496 ETH of protocol fees
across all four legs. Note `disableCache` is on for chain 31337 — Ponder's RPC cache
keys on chain id and block number, and a restarted anvil reuses both for an entirely
different chain.

`ponder start` additionally needs `DATABASE_SCHEMA`, which it will not guess. See
`.env.local.example`.

### If the build fails with "File execution did not complete (waited 10s)"

Ponder gives each file in `src/` a hard ten seconds to be imported, and the limit is not
configurable (`node_modules/ponder/src/build/index.ts:211`). On a loaded machine that is
easy to exceed — during one afternoon here PGlite's own connect took between 57 and 108
seconds, and the build failed on `src/pair.ts` on five consecutive attempts before
succeeding once the machine was quieter. It reports whichever file the timer happened to
expire on, so the named file is not usually the problem. Close whatever else is
compiling and try again; nothing needs changing.

## Running it against a testnet

Every chain needs an endpoint named explicitly: the config throws on a chain that has a
launchpad configured but no `<KEY>_RPC_URL`. The public endpoints do serve a
testnet-sized backfill — `ethGetLogsBlockRange: 9_000` turns Ink Sepolia's 563,580 blocks
since the deploy into 63 chunks per contract, not the tens of thousands a mainnet needs —
so the throw is about the choice being deliberate rather than about the load being
impossible. There is no throttle to reach for either way: `maxRequestsPerSecond` still
type-checks in 0.17 but is deprecated and read nowhere in the compiled output, so Ponder's
own backoff is the whole rate strategy.

Set `START_BLOCK_<KEY>` to the launchpad's deploy block. Zero works and walks the chain
from genesis, which on Robinhood's 0.1-second blocks is millions of empty blocks;
`POINTS_FROM_BLOCK_<KEY>` is read as a fallback because it is the same number whenever
the two contracts went out together.

### What a real chain produced

Measured against Ink Sepolia on 2026-08-31, with the public endpoint and PGlite: the
backfill completed in **2m 45s**, absorbing 26 `-32016` rate-limit errors through the
retry, and found two launches — matching the launchpad's own `tokenCount()` exactly —
both graduated, 21 fills across curve and pool, and both pairs discovered from
`Graduated` with no factory address configured.

The fee ledger came out as 0.400000 ETH `graduation`, 0.140300 ETH `trade` and 0.000000
ETH `creation`. That last figure is right, not missing, and it is the reason the handlers
read at the event's block rather than at head: `creationFee()` was zero when both tokens
launched and is 610816335672081 wei now, so reading head state would have invented
0.00122 ETH of revenue that nobody was ever charged. The app's scan does exactly that —
`lib/scans.ts:110` documents the hazard as hypothetical, and on this chain it has already
happened.

## Deploying

Ponder is a long-running process, so this cannot live on Vercel next to the web app. It
needs a host that runs a container and a Postgres. `railway.json` in this directory
configures Railway; the same four settings apply anywhere.

**This directory is self-contained on purpose.** Railway and Render build a service from
one subdirectory and nothing above it exists there, so the two files that used to reach
outside are generated into the tree and committed: `abis/generated.ts` (from the Foundry
build, which is gitignored) and `vendor/curve.ts` (from `web/lib/curve.ts`). Both are
regenerated on every local `dev` and `start`, so neither can quietly go stale while
somebody edits the original, and both fall back to the committed copy when the original
is out of reach. That is what makes `npm ci && npm start` the whole build.

### Railway

Root Directory `indexer`, and Railway picks up `railway.json` from there. Add a Postgres
to the project, then set the variables:

<!-- `railway.json` is Railway's deprecated Config-as-Code form, honoured until
2026-12-01. Its replacement is `.railway/railway.ts`, and `railway config migrate`
translates this file — but the translation silently drops the restart policy and adds a
`railway/iac` import, so it is worth doing against a live project where
`railway config plan` can show what would change, not blind. -->

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `DATABASE_SCHEMA` | `uw_${{RAILWAY_GIT_COMMIT_SHA}}` |
| `LAUNCHPAD_<KEY>` | the deploy address, per chain |
| `START_BLOCK_<KEY>` | the deploy block, per chain |
| `<KEY>_RPC_URL` | the endpoint, per chain |

`PORT` Railway sets itself. `<KEY>` is the same word the rest of the repo uses —
`INK`, `INK_SEPOLIA`, `ROBINHOOD`, `ROBINHOOD_TESTNET` — and a chain with no launchpad
address is skipped rather than started empty, so only the ones actually deployed need
rows here.

Two things go wrong if you skip them, and both look like something else:

**Point the health check at `/health`, not `/ready`.** Both exist and they mean
different things: `/health` returns 200 as soon as the process is up, while `/ready`
waits for the backfill to finish. On the Ink Sepolia run above that was a 3½-minute gap,
and a mainnet backfill is longer — a host checking `/ready` with the usual short timeout
kills the container and restarts it, forever, never getting past the backfill. This is
why `railway.json` names `/health` explicitly. `/ready` is the right signal for cutting
traffic between deploy slots, which is what `DATABASE_SCHEMA` is for.

**`DATABASE_SCHEMA` has to rotate with the code.** Pointing a new build at a schema an
older one wrote is a hard error rather than a migration — Ponder compares build ids and
throws `Schema "…" was previously used by a different Ponder app`
(`database/index.js:496`). Deriving it from the commit sha satisfies both halves at once:
new code gets a clean schema, and a restart of the *same* commit reuses its schema and
resumes from where it stopped instead of backfilling again. Old schemas accumulate in
Postgres; `ponder db list` shows them and `ponder db prune` drops the ones no live
deployment is using.

### Chains that need an archive RPC

`TokenCreated` is handled with three `eth_call`s at the event's block, and a chain whose
endpoint has discarded that block's state cannot be indexed from its deploy block at all.
The failure is loud but misleading: the backfill sits at 0.0% and retries forever with
`InvalidInputRpcError: metadata is not found, <block>`, which reads like a bad address or
a rate limit rather than missing state.

**Robinhood Testnet (46630) is in exactly that position.** Its public endpoint,
`rpc.testnet.chain.robinhood.com`, is not an archive node: a binary search over
`pools(address)` put its retention at roughly **11,166 blocks**, and at 0.15-second blocks
that is about **28 minutes** of history. Reads at `latest` succeed; the launch this repo
made there is some 700,000 blocks back, so its creation block is long gone. The three
`*_ROBINHOOD_TESTNET` variables are therefore unset on the deployed service — a chain with
no launchpad address is skipped, which is better than a retry loop that also pins `/ready`
at 503 forever. Indexing 46630 needs either an archive endpoint or the rewrite below.

Two of the three reads are removable, and the third is the real work:

- **`pools(token)` carries no information the contract's own constants don't.** `create()`
  writes the pool as `VIRTUAL_ETH_RESERVE` / `INITIAL_TOKEN_RESERVE` / `realEthRaised: 0`
  and *then* emits `TokenCreated` (`UnderwaterLaunchpad.sol:246-258`), so the seeded row is
  those two `public constant`s by construction. Reading them at head is sound for the same
  reason the `graduationEth` memo is, and it is strictly more correct than what happens
  now: the optional initial buy runs after the emit, so a state read at the event's *block*
  actually returns post-buy reserves, which the `Trade` handler then overwrites anyway.
- **`graduationEth` and `totalSupply` are already `constant`** — they only need reading at
  head rather than at the event's block.
- **`creationFee()` is genuinely mutable, and the log does not carry it.** `TokenCreated`
  has no fee argument, so the exact figure charged at a past block cannot be recovered from
  the event stream in one forward pass. It *is* recoverable overall, because
  `CreationFeeUpdated(uint256 oldFee, uint256 newFee)` carries the old value: the fee at
  block B is the `oldFee` of the earliest update after B, or the head value if there is
  none. That is a fee-timeline table plus a resolution step in the fee query, not a
  one-line change, which is why it is written down here rather than done in passing.

Head-reading `creationFee` as a shortcut is specifically ruled out: it would have invented
0.00122 ETH of revenue on Ink Sepolia, as the section above records.

### Wiring the app to it

Done, and it changes no component. Set one variable in `web/.env.local`:

```
INDEXER_URL=https://indexer-production-83a4.up.railway.app
```

Unprefixed, so it is server-only. Nothing in the browser talks to this service: the four
routes in front of it (`/api/market`, `/api/volume`, `/api/points`, `/api/points/history`)
are what carry the CDN headers, the shared memo and the wire encoding, and a tab reading
the indexer directly would bypass all three and put a database behind a per-block poll.
Unset is a supported state and means "use the chain".

`web/lib/indexer.ts` is the adapter, and it is the only place that knows both vocabularies.
The routes call it first and fall back to what they did before on **any** of: no variable,
a chain this indexer does not serve, an unfinished backfill, a timeout, a non-2xx, a
launchpad that is not the one the app is pointed at, or a payload that does not decode.
The points routes add one more — a waitlist or points address that is not the app's — and
they check it *there* rather than in the shared probe, so a points misconfiguration cannot
take the market list down with it.

The mapping is not the identity, which is worth saying because the earlier draft of this
section claimed it was. The tables are named for what they store and the app's types are
named for what they render, so `metadataUri` → `metadataURI`, `progressBps` → `progress`,
`address` → `token`, and the four curve columns fold into a nested `pool`. Volume is a
bigger gap: `Volume` wants a lifetime total *and* a rolling day *and* four named fee legs,
where the tables hold rows. `/volume` does that shaping in SQL — two `movedIn` windows, two
`legsOf` groupings, one `opensIn` pair of `DISTINCT ON` passes — and the route applies the
one leg no database can know.

Three deliberate asymmetries:

- **The `/ready` gate is the whole design.** A half-backfilled indexer does not answer with
  nothing, it answers with totals that are too *small* — and unlike the scan, which reports
  how far back it reached so the card can say "so far", a `SELECT` has no way to admit it.
  So until Ponder's `/ready` is 200 the chain is the better source, and the app does not ask.
  Passing that gate is also what lets `Volume.allTime` be set true.
- **The pool fee leg stays in the app.** `UnderwaterPair` accrues the protocol a sixth of
  each pool's 0.3% only while the factory's `feeTo` is set, which is chain state this
  indexer does not track. So `/volume` publishes pool volume as a fact and
  `/api/volume`'s own `feesOf` derives 5 bps of it behind its own `feeToFor` gate — the
  same code path on both sources.
- **`/chains` exists because zero rows is ambiguous.** A `SELECT` over a chain this process
  was never configured for is indistinguishable from a chain that is indexed and has had no
  launches, and answering the market page with the second when the truth is the first shows
  a visitor an empty market on a chain that has launches. It is called `/chains` and not
  `/status` because Ponder registers `/metrics`, `/health`, `/ready` and `/status` on the
  Hono instance that hosts ours and mounts ours underneath them, so a route by that name
  would never be reached. Its `/status` is the better one anyway: it reports each chain's
  indexed head, which only Ponder knows, and that is where the block range on `/api/volume`
  comes from.

Measured through `/api/volume` on Ink Sepolia the day this landed, against the deployed
service: `allTime` true, `day.seconds` exactly 86,400 on the first read, `blocks` 576,784
(the deploy block to the indexed head, not "as far back as the scan reached"), and
`fees.total` 0.548100 ETH — `curve` 0.140300 + `graduation` 0.400000 + `pool` 0.007800
derived in the route from indexed pool volume behind `feeToFor`, + `launch` **0**.

That last figure is the one visible correction. The scan reports 0.00122 ETH there, because
a counter is all it has and it values every launch at today's `creationFee`; both of these
launched while the fee was zero. Nobody was ever charged it.

`lib/stats.ts` needed no change: it polls `/api/volume` and decodes `Volume`, which is the
same type either way.

One thing the adapter has to do that reads like an inconsistency: block numbers off Ponder's
`/status` go through their own decoder rather than `lib/wire.ts`'s `big`. `big` refuses a
JSON number on purpose — every integer on our own routes is a decimal string, so a number
means something upstream put a wei figure through a double — and `/status` is not ours and
never made that promise. Loosening `big` to accept it would have removed that check
everywhere to satisfy one field.

### Sorting and paging the whole market

`/api/market` takes `sort` and `offset` now, and honours them **only** on this path. That is
not a shortcut: walking the launchpad's index counter downwards is the only ordering the
chain offers without reading every launch that ever happened, and ordering by market cap or
volume means comparing figures that have to exist first. So the route answers either request
and reports what it managed, on `MarketState.sort`, `.offset` and `.whole` — and the market
page drops the two sorts that need the whole market rather than lighting a control that
quietly returns the newest launches.

Five orderings, of which `new`, `progress` and `cap` are columns on every listing and so
still work in the browser over a page it already has. `volume` and `active` are the two that
only exist here. `volume` is the **lifetime** counter — "most traded ever", which is what a
column can answer; "busiest today" is an aggregate over `trade` and is not wired.

Two decisions bound the cost, and both are about cache keys rather than SQL:

- **A page is `MARKET_LIMIT`, and the route snaps `offset` to a multiple of it.** The grid
  shows 24 or 12 at a time, so honouring an arbitrary offset would key the shared cache on
  where a visitor happens to be scrolled *and* on their view mode. Instead a page of the
  market is one hundred, the browser walks it, and only crossing an edge is a fetch. Keys
  stay `sorts × ceil(tokenCount / 100)`.
- **The key is what can be served, not what was asked for.** `indexerServes` runs before the
  memo key is built, so during an outage every sort and page collapses onto `market:<id>:new:0`
  instead of each one paying 400 contract calls for the same newest hundred. The probe verdict
  is already cached, so asking costs no request.

Search and the stage filter stay client-side over the fetched page. Pushing them down would
mean a `WHERE` per search term, and the route's memo is an unbounded `Map` — so the pager
says "matching on this page" when the market is larger than one, rather than counting a
page-local filter against the whole market. Server-side search is the next piece.

`lastTradeAt` is nullable, and Postgres sorts nulls *first* in a descending order, so
`active` orders `desc nulls last` explicitly. Without it "recently active" would open with
the launches that have never traded at all.

### uwPoints

Two more contracts and three more tables. `WAITLIST_<KEY>` and `POINTS_<KEY>` are both
optional and independent — a chain with a launchpad and neither of them still indexes
launches and trades, and the points routes answer with what exists.

What is stored:

- **`account`** — one row per wallet per chain, holding `registered`, `position`,
  `registeredAt`, `referrer`, and four counters: `referrals`, `creates`, `trades`,
  `granted`. Everything except `granted` is a count. Ranking is `ORDER BY` an expression
  over those counters with the rate card interpolated, which is why there is no `points`
  column and no index on one.
- **`registration`** — the waitlist log itself, so a history can show the row rather than
  infer it from `account.registered`.
- **`pointGrant`** — `Redeemed` and `Granted`, the two events that carry a number of
  points in the log. Grants are cumulative and never decremented, so their sum over
  history *is* the contract's `granted[who]` — which makes it a cross-check rather than a
  duplicate, and the app warns when the two disagree.

Trades and launches need no new table: `trade.trader`/`trade.logIndex` and
`token.createdTx`/`token.createdLogIndex` were the only missing columns, and a history row
comes straight off them.

Two routes:

- **`/points`** returns one wallet's counters, its downline, `participants`, and `ahead` —
  a `count(*)` of wallets scoring higher, with the four rates passed in as query
  parameters and validated against `^\d{1,20}$` before they reach the SQL. That replaces a
  20,000-row in-memory leaderboard built to derive a single rank.
- **`/points/history`** returns one wallet's rows, newest first, **unpriced**. Five reads,
  merged and ordered by `(blockNumber, logIndex)` — the only total order over logs, since
  Robinhood makes ten blocks a second and a timestamp cannot separate them.

Three things stay in the app, and they are the reason `web/app/api/points/route.ts` did
not simply get shorter:

- **The rate card.** Read from the chain, per the design note above. The indexer never
  reads it and never stores a price.
- **The activity gate.** Whether a referral has cleared the bar depends on a nonce and a
  lending position on two *other* chains. No log on this one records it, so
  `web/lib/activity.ts` still checks, still bounded by `VERIFY_MAX`, still sharing one
  verdict memo with the history route.
- **`granted` for display.** The indexed sum is compared against `granted[who]` and the
  contract's value wins. A sum that has drifted is a bug worth logging, not worth showing.

Two bounded divergences, written down rather than smoothed over:

- **`ahead` prices referrals ungated.** The rank counts raw referrals where the
  breakdown beside it counts activity-verified ones, because the gate is off-chain and a
  `count(*)` cannot call it. The error is at most `rates.referral × (referrals −
  validReferrals)` and only ever *flatters* wallets with unverified downlines. Ranking
  every wallet honestly would mean verifying every wallet's downline on every read.
- **Pool swaps count on launch pairs only.** Pairs are discovered from `Graduated`, so a
  swap on some other pair the DEX factory made earns 10 points on the RPC path and
  nothing here. The two sets coincide on Ink Sepolia today: both launches have graduated,
  and the factory's `allPairsLength()` is 2 — the same two pairs — so no row differs. They
  diverge the first time anybody creates a pair on the factory directly, which anybody
  may, and the narrower set is the anti-farm choice on a public AMM. Kept deliberately
  rather than by omission.

`Swap.to` is what credits a pool trade, which credits buys and not router sells: the
router receives the WETH leg, and a multi-hop sends its output to the next pair. So
infrastructure addresses are *excluded* rather than bucketed — the same thing the app's own
`poolIn` does, and admits to.

**Deploying this needs a new `DATABASE_SCHEMA` and a full re-index.** Ponder's build id
covers the schema as well as the config, so pointing this build at `uw_sorts_ink` is a hard
error rather than a migration. Give it a fresh slot; the old one keeps serving until the
backfill finishes.

## What is not here yet

- **A backfill of the `swap` fee leg**, for the reason above.
- **Windowed volume as a sort key.** `token.volumeWei` is lifetime, so "most traded" means
  ever. A 24-hour ordering is `SUM(eth_amount) … GROUP BY token ORDER BY 1 DESC` over
  `trade`, which is a different query from the five that share the market list's indexes.
- **Search and stage as SQL.** `ILIKE` on name/symbol and `WHERE graduated` would make both
  cover the market instead of the page; what needs settling first is that a term-keyed cache
  key is unbounded, so it wants a bypass of the route memo rather than an entry in it.
- **`tokensSold` as a column** — and it does not need one. `Trade` does not carry it, but
  the launchpad writes `tokenReserve` and `tokensSold` as exact mirrors wherever either
  moves (`UnderwaterLaunchpad.sol:250`, `:321`/`:323`, `:387`/`:389`, and graduation writes
  neither), so their sum is `INITIAL_TOKEN_RESERVE` for the life of the pool — the same
  `1_000_000_000e18` as `TOTAL_SUPPLY`. `web/lib/indexer.ts` derives it from the row.
- **Reorg-depth tuning.** Ponder handles reorgs; the defaults have not been checked
  against either chain's actual finality.
