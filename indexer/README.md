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
the market can only show the newest hundred, and it can never offer "sort by 24-hour
volume", search, or pagination, because ordering by volume needs every launch's figures
to exist before you can order by them. The log scan also grows with the number of
*pairs* rather than with the window, so it gets slower as launches accumulate even for a
fixed day.

Indexing inverts it. One forward-only process reads each event once, and the questions
become queries:

| Question | Today | Here |
| --- | --- | --- |
| Market list | 400 `eth_call` per window | `SELECT … ORDER BY … LIMIT` |
| 24h volume | ~20 `eth_getLogs` per cold instance | `SUM(eth_amount) WHERE timestamp > …` |
| 24h open per launch | first `Trade` found in the scanned window | `DISTINCT ON (token) … ORDER BY timestamp` |
| Protocol fees | scan + four separate derivations | `SUM(amount_wei) GROUP BY kind` |
| Candles | reconstructed per request at a fixed grain | one row per bucket, written once |
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
needs a host that runs a container (Railway, Fly, Render) and a Postgres. Three variables
beyond the per-chain ones:

- `DATABASE_URL` — Postgres. Ponder manages its own schema and migrations.
- `DATABASE_SCHEMA` — the deploy slot. `ponder start` requires it; give each release its
  own name so the previous one keeps serving through the new one's backfill.
- `PORT` — the HTTP server, if the host does not set it.

The web app then reads it instead of scanning. That change is confined to the API
routes and `lib/stats.ts`: the response shapes in `src/api/index.ts` deliberately match
what the client already parses, `bigint`s serialised as decimal strings the way
`lib/scans.ts` expects, so the components do not change.

## What is not here yet

- **uwPoints.** Balances are counted off-chain from logs the contracts already emit
  (`web/lib/points.ts`), which is the same rescan-per-instance problem in a different
  route. It is the obvious second thing to index, and it was left out to keep this
  scaffold to one subject.
- **A backfill of the `swap` fee leg**, for the reason above.
- **`tokensSold`.** `Trade` does not carry it, and nothing in the display path needs
  it — `previewBuy` runs in the browser against a live contract read.
- **Reorg-depth tuning.** Ponder handles reorgs; the defaults have not been checked
  against either chain's actual finality.
