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

**`TokenCreated` reads state, so a chain needs an archive endpoint.** This is the one
requirement that is not obvious from the config, and it is what stops Robinhood Testnet
being indexed from its deploy block today — see "Chains that need an archive RPC" below.

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

Confined to the API routes and `lib/stats.ts`: the response shapes in `src/api/index.ts`
deliberately match what the client already parses, `bigint`s serialised as decimal
strings the way `lib/scans.ts` expects, so the components do not change.

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
