# Underwater ZEC — trading engine

The off-chain engine behind the Zcash launchpad ([docs/underwater-zec-v2.md](../docs/underwater-zec-v2.md)): the bonding curve, graduation and built-in DEX from the Robinhood/Ink launchpad, ported line for line to TypeScript and **proven equal to the deployed contracts** by a differential harness.

Zero runtime dependencies. Node ≥ 23.6 runs the `.ts` files directly.

```bash
node --test "test/**/*.test.ts"   # unit, invariant-fuzz, custody, store and rails tests
node parity/run.ts                # engine vs. the real contracts (needs Foundry)
node demo.ts                      # a narrated launch on ZEC parameters
node rails/probe.ts               # live, read-only check against Zcash testnet
node ../web/node_modules/typescript/bin/tsc -p .   # type-check
```

## Layout

| Path | What |
|---|---|
| `engine/math.ts` | `CurveMath`, `_mulDivUp`, `_toU128` and the V2 library math, as exact bigint ports |
| `engine/config.ts` | `EVM_PARAMS` (the contract's constants) and `ZEC_PARAMS` (V = 1.5 ZEC); `validateCurve` refuses any set that breaks the curve's geometry |
| `engine/ledger.ts` | Double-entry ledger. Every movement is a zero-sum journal entry; `verify()` rebuilds all balances from the journal |
| `engine/engine.ts` | The single-writer engine: create / buy / sell / graduate / AMM swaps / fees / deposits / withdrawals, each atomic with rollback |
| `engine/hashchain.ts` | Tamper-evident command log. Its head hash is what gets anchored on-chain |
| `engine/store.ts` | Durable log: fsynced before a command takes effect, replayed and hash-verified on open, tolerant of a torn last write |
| `rails/rails.ts` | Deposits in, withdrawals out: credit, mature, reverse on reorg; batch, record, broadcast, settle or refund |
| `rails/wallet.ts` | The `ZcashWallet` seam: everything that needs Zcash keys sits behind it |
| `rails/sim.ts` | Deterministic chain for tests: reorgs, double-spends, expiries, failed broadcasts |
| `rails/lightwalletd.ts` | Dependency-free gRPC client for lightwalletd (tip, blocks, tx lookup, broadcast) |
| `parity/` | Scenario generator, op encoding, and the runner that diffs the engine against Foundry |
| `../test/zec/ZecParity.t.sol` | The Solidity half: replays scenarios on the real launchpad, factory, router and pair |

## How parity works

1. `parity/gen.ts` writes random scenarios. It uses the engine to aim: slippage bounds exactly at, and one unit past, the quote; sells sized from real holdings; buys landing on, under and through the graduation threshold; fee changes over the cap.
2. `ZecParity.t.sol` replays each scenario against the real contracts (launchpad wired to the real DEX, as in `LaunchpadOnUnderwaterDex.t.sol`) and records, after every op, the outcome code, every user's ETH and token balances, the fee recipient, each curve's reserves, each pair's reserves and each token's supply.
3. `parity/run.ts` replays the same ops through the engine and requires every one of those numbers to match.

It is skipped in a plain `forge test` (it needs `ZEC_PARITY=true`), so the normal suite never depends on generated fixtures. The only repo config it needs is `fs_permissions` for `zec/parity/fixtures/`.

Last results (2026-09-26): **8,640 ops across 36 scenarios, 72 graduations, zero divergence.** Success paths plus 9 distinct revert types exercised.

## Things the port makes visible

- **ZEC prices are sub-zatoshi.** ZEC has 8 decimals, and an early meme token is worth ~0.15 zats. The contract-style `spotPriceE18` floors that to 0, so the engine's product views (`priceX18`, `marketCap`) work from reserves instead. `spotPriceE18` stays only for parity.
- **Graduation can leave dust unsold.** Rounding favours the pool, so a curve can hit the quote threshold a few base units short of 800M sold. `_graduate` burns the remainder, and so does the engine.
- **Price drops ~24% at graduation** (inherited from the contracts): the curve ends at 25V FDV, the pool opens at 20V × (1 − graduation fee).

## Custody (step 2)

**Deposits.** Each user gets their own diversified address. A note is credited at 3 confirmations and can be traded, but not withdrawn, until 10. If a reorg drops it before then, it is reversed. Whatever the user already spent is covered from protocol fees, and anything past that is recorded in a `loss` account, never absorbed silently. Deposits over 5 ZEC skip the fast credit and wait for 10 confirmations, which caps what a double-spender can move. A deposit's id is its note id, so rescans never pay twice.

**Withdrawals.** A request debits the amount plus a flat 0.0001 ZEC fee. The rails batch requests into one transaction, record it in the log *before* broadcasting, and settle it at 10 confirmations. An expired transaction is refunded; expiry makes it unmineable (ZIP-203), so a refund can't double-pay. A crash between recording and broadcasting resends the same transaction.

**Durability.** Every decision lives in the engine's log, and the rails keep nothing only in memory. A restart replays the log, rescans from the wallet birthday, and carries on. `rails.reconcile()` compares the hot wallet with the ledger: positive drift is dust or stray payments, negative drift means ZEC is missing.

**Tested against** reorgs that drop or re-mine a deposit, a double-spend of an already-spent deposit, expired and never-broadcast withdrawals, a stall longer than the scan window, a hot wallet short of funds, and a restart in the middle of a withdrawal.

## The treasury wallet (step 2b)

`wallet-service/` is a Rust service on Railway (project `underwater-zec-wallet`, kept separate from everything else because it holds a spending key). It is a librustzcash wallet (`zcash_client_backend` 0.24 + `zcash_client_sqlite` 0.22, versions and lockfile taken from ECC's `zcash-devtool`), syncing from `testnet.zec.rocks`:

- **Deposit addresses:** Orchard-only unified addresses at explicit diversifier indices, so the engine's index → user mapping is the wallet's own.
- **Incoming:** non-change notes from the Orchard, Ironwood (NU6.3) and Sapling tables, up to the fully scanned height.
- **Withdrawals:** ZIP-317 fees, greedy input selection, Halo 2 proofs built in-process. It reports "expired" only once every block through the expiry height has been scanned, because the rails refund on that signal.
- **Seed:** generated inside the service on first start and kept on the `/data` volume. It is never logged or returned.
- **Access:** every route except `/health` needs `Authorization: Bearer <WALLET_API_TOKEN>`.

`rails/http-wallet.ts` is the matching `ZcashWallet`, and `rails/run.ts` runs the whole loop:

```bash
node rails/wallet-smoke.ts   # read-only checks against the deployed service
node rails/run.ts            # the rails: durable engine + wallet + 15 s ticks
```

Both read `WALLET_URL` and `WALLET_API_TOKEN` from the environment or `zec/.env.wallet` (gitignored). `node rails/address.ts <user>` assigns and prints a user's deposit address through the durable engine.

Verified live on 2026-09-26: the account was created at birthday 4,397,068 and synced to the tip with zero lag. Addresses are distinct and stable, and a wrong token is refused. The rails ticked against the real chain with reserves reconciling at 0 drift.

**Round trip** (`node rails/e2e.ts`, same day): a 0.1 TAZ faucet deposit was credited at 3 confirmations and traded (a TPEPE launch, a buy and a sell). It became withdrawable at 10. A 0.03 TAZ withdrawal was proved, broadcast and settled at 10 confirmations, with a 0.0001 TAZ network fee. The ledger balances to the zatoshi. The deposit landed in the **Ironwood** pool.

Known gap: payments the treasury sends to *its own* addresses (like the e2e's self-send) don't appear in `incoming`, most likely because the wallet records outputs of its own transactions as change. External deposits are unaffected.

## Not yet
- No HTTP API yet: that's step 3.
- Deep reorgs (more than 10 blocks) of already-mature deposits aren't detected; finality at 10 blocks is a policy assumption.
