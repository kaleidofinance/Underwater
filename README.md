# underwater.fun

**The meme launchpad on Zcash.** Anyone can launch a token in seconds and trade it instantly: a bonding curve that graduates into a built-in DEX, because Zcash has no Uniswap. Deposit ZEC once; everything after is instant.

Live on **Zcash testnet** at [www.underwater.fun](https://www.underwater.fun). Mainnet follows once testnet is clean.

## How it works

Zcash has no smart contracts, so trading runs in an off-chain engine and the chain handles custody:

- **Engine** ([`zec/engine`](zec/engine)). The launchpad's curve, graduation and constant-product DEX, ported line for line from Solidity and proven identical to the contracts by a differential harness ([`zec/parity`](zec/parity)). Every command is atomic, double-entry and appended to a hash-chained, fsynced log.
- **Rails** ([`zec/rails`](zec/rails)). Deposits are credited at 3 confirmations and withdrawable at 10, and reversed if a reorg drops them. Withdrawals are batched, recorded before broadcast, and settled at finality.
- **Treasury wallet** ([`zec/wallet-service`](zec/wallet-service)). librustzcash over lightwalletd, in Rust, reachable only over a private network. It has two accounts: **treasury** owns every user's shielded deposit address; **reserve** holds the funds and pays withdrawals.
- **API** ([`zec/server`](zec/server)) and **web app** ([`web`](web)). Accounts are Ed25519 keys generated in the browser, and every write is signed. Trades stream live over SSE.

## Verify us, don't trust us

- **Liabilities.** A Merkle-sum tree of every balance is published at `/api/solvency`, and each user's browser checks its own balance is in it.
- **Reserves.** The reserve's viewing key is public at `/api/audit`. Import it into any Zcash wallet to watch what we hold. Withdrawals hide their destinations.
- **History.** Every hour the log's head hash is written into a reserve memo, so the history the liabilities come from can't be rewritten quietly.

## Run it

```bash
node --test "zec/test/**/*.test.ts"   # engine, custody, rails, server
node zec/parity/run.ts                # engine vs. the Solidity reference (needs Foundry; git submodule update --init first)
node zec/server/main.ts --sim         # API on :8811 over a simulated chain, with a test faucet
npm --prefix web run dev              # web app on :3000 (copy web/.env.local.example to web/.env.local)
```

Design and market research: [`docs/underwater-zec-v2.md`](docs/underwater-zec-v2.md) (current architecture and build plan), [`docs/underwater-zec-market.md`](docs/underwater-zec-market.md), and [`docs/underwater-zec.md`](docs/underwater-zec.md) (the first spec, superseded).

## History

underwater.fun started as a meme launchpad on Ink and Robinhood Chain. That version is retired and archived, with its full history, at [kaleidofinance/underwater-evm](https://github.com/kaleidofinance/underwater-evm). Its launchpad and DEX contracts live on here only as the parity reference in [`zec/parity/reference`](zec/parity/reference).
