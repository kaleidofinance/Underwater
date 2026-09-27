# Underwater ZEC v2 — instant meme launchpad

**Status:** draft architecture, 2026-09-26. **Supersedes** the call-auction core of [underwater-zec.md](underwater-zec.md). That doc is kept for the ZRC-20 reference, the wallet findings, and the optional auction mode (§11).

**Goal:** pump.fun / pons UX on Zcash. Anyone launches a meme token in seconds and anyone trades it instantly, with a chart that moves, on our own built-in DEX.

---

## 1. The shape: deposit once, trade instantly forever

Zcash has 75-second blocks and no contracts, so nothing that settles on-chain per trade can feel like pump.fun. Instant trading therefore happens in **our engine**, and the chain is touched only when money enters or leaves. Every centralised exchange works this way, and it is the only way to get this UX on Zcash.

| Layer | Does | Speed |
|---|---|---|
| **Chain** (Zcash) | Deposits in, withdrawals out, reserve proofs, on-chain token records | Minutes (touched rarely) |
| **Engine** (ours) | Accounts, balances, bonding curve, graduation, AMM, fees, candles | **Sub-100 ms** |
| **Web** (ours) | Create, trade, charts, profiles | Instant |

The price of this is custody: we hold users' ZEC and tokens while they're inside. v1 already needed custody for bids; v2 extends it to everything. §9 covers how we make that trustworthy.

---

## 2. We are reverse-engineering our own product

The launchpad logic already exists and is battle-tested on Robinhood and Ink. Zcash changes the settlement layer, not the product.

| Component | Source today | Zcash v2 |
|---|---|---|
| Bonding curve | `src/lib/CurveMath.sol` | Engine — identical integer math, zatoshi instead of wei |
| Buy / sell / quote / graduate | `zec/parity/reference/src/UnderwaterLaunchpad.sol` | Engine |
| Built-in DEX | `src/dex/UnderwaterPair.sol` (V2 fork, 0.3%, `feeTo`) | Engine's internal AMM |
| Fees | trade ≤ 2%, graduation ≤ 10%, capped creation fee | Same levers, same caps |
| Front end | `web/` — create flow, token pages, own candles, market grid, profile | Fork; swap wallet-connect for account + deposit |
| uwPoints | existing | Carries over |

The math being ported, verbatim:

```
tokensOut = tokenReserve · ethIn    / (ethReserve   + ethIn)      // buy
ethOut    = ethReserve   · tokensIn / (tokenReserve + tokensIn)   // sell
```

**Parity is a hard requirement.** A differential test harness generates random trade sequences, runs each through the Solidity contract (forge) and through the engine, and asserts identical reserves, outputs and fees at every step, rounding direction included. The contract has survived real money on two chains; the port inherits that only if it's provably the same function.

---

## 3. Curve parameters in ZEC

The existing geometry: virtual reserve `V`, a 1B-token virtual reserve, and graduation at `4V` raised. At that point exactly 800M tokens have sold, which is `CURVE_SUPPLY`. Everything scales off `V`:

| | Formula | **V = 1.5 ZEC** (recommended) | V = 3 ZEC |
|---|---|---|---|
| FDV at first buy | `V` | 1.5 ZEC ≈ $2.3K | 3 ZEC ≈ $4.6K |
| Raise to graduate | `4V` | 6 ZEC ≈ $9.2K | 12 ZEC ≈ $18.4K |
| FDV at graduation | `25V` | 37.5 ZEC ≈ **$57.5K** | 75 ZEC ≈ $115K |

(At ZEC = $1,534.) V = 1.5 puts graduation near pump.fun's historical ~$69K mark. The USD values float with ZEC, which went ~$200 → $1,534 in a year, so re-check `V` if ZEC moves by more than about 2×.

Post-graduation pool, mirroring `_graduate`: `(4V − graduation fee)` ZEC paired with the 200M `LP_SUPPLY`. The LP is locked as protocol-owned, and unsold curve tokens are burned.

---

## 4. Accounts

Every user has an **Ed25519 account key**. It:

- **signs every API request.** No passwords, no email, and nothing to leak in a database breach.
- **is the ZRC-20 `acct`** that token withdrawals land in.

Two ways to get one:
- **From MetaMask:** `personal_sign` over a fixed, domain-bound message, hashed into an Ed25519 seed. It recovers from the same MetaMask with no new seed phrase, and RFC 6979 makes it deterministic. The message has to name our domain and say what it does, because any site that gets a user to sign the same text derives the same key.
- **Generated in-browser**, with explicit export and backup, for non-MetaMask users.

---

## 5. Deposits: one private address per user

Orchard supports **diversified addresses**: effectively unlimited unlinkable addresses from one key, all detectable by one incoming viewing key. Every account gets its own deposit address, and we credit whoever owns the address that received funds.

**No memo is needed.** That makes the v1 wallet work mostly moot:
- **Zodl:** scan the QR and send. Plain payment.
- **MetaMask Zcash Snap:** WebZjs `pczt_create(account, to, value)` works **as-is**. The memo fork from v1 §12 is no longer needed.
- **Exchange withdrawals** (Coinbase, Binance, etc.) straight to the deposit address also work, which matters a lot for onboarding.

Confirmations (tunable):
- **Tradable at 3** (~4 min)
- **Withdrawable at 10** (~12.5 min, the ZRC-20 draft's reorg depth)

Between 3 and 10 we carry reorg risk on deposited funds. That's acceptable on Zcash today; cap it by only fast-crediting deposits under a size limit.

---

## 6. Engine

- **Double-entry ledger** (Postgres). Every movement is a balanced journal entry, and balances are derived, never stored as mutable truth. This is what makes solvency provable in §9.
- **Single-writer sequencer.** All trades go through one ordered log, so there are no races and no double-spends inside the engine, and every trade's output is deterministic.
- **Curve → graduation → AMM**, straight from §2. Graduation fires inside the same sequenced step as the trade that crosses `4V`. There is no separate transaction to fail, which makes it simpler than the EVM version, where `GRADUATION_GAS_RESERVE` exists only to guard exactly that failure.
- **Candles from our own trade log**, reusing the own-candles pipeline. We never depended on DexScreener, and here nobody else could index us anyway.
- **Tamper-evident log.** Each batch of events is hashed into a chain (every hash includes the previous one). Every N blocks, publish the head hash **in a Zcash memo**. It costs almost nothing and anchors our history to the chain, so a rewritten past becomes detectable.

---

## 7. Token creation

Instant in the engine. Name, symbol and image are **metadata**, and duplicates are allowed exactly as on pump.fun.

On-chain identity is a separate question. ZRC-20 tickers are 1–8 bytes, globally unique and first-come, so meme symbols can't be the on-chain key. Each token instead gets a **generated 8-byte ZRC-20 ticker**, the way pump.fun's identity is the mint address rather than the symbol.

**Deploy on-chain lazily**, at graduation or on the first token withdrawal. 84% of existing ZRC-20 tokens never found a second holder (market doc §2), and there's no reason to pay and clutter the chain for those.

---

## 8. Withdrawals

- **ZEC:** to any Zcash address, batched every block from the hot wallet.
- **Tokens:** ZRC-20 `transfer` from our custody account to the user's `acct`, via the v1 §7 pattern (deploy → mint to ourselves → transfer out). The result is valid plain ZRC-20 that any independent indexer will agree on.
- **Early limits:** per-account daily withdrawal caps while the system proves itself.

Withdrawals are non-negotiable from day one. Without them we'd be running a casino with no exit.

---

## 9. Custody and solvency

The whole product is custodial now, so this section is what separates us from zkSNARKs taking $17.5M with nothing binding them.

**Wallet structure**
- **Hot wallet** holds a small percentage of liabilities, enough for normal withdrawals.
- **Cold** holds the rest under **FROST threshold signing**. The Zcash Foundation's FROST tooling supports Orchard's RedPallas, which gives a real k-of-n multisig for shielded funds. Verify its production maturity before relying on it.

**Proof of reserves, published on a schedule**
1. Deposits land on private per-user addresses, then get **swept into a reserve address whose viewing key is public**. Anyone can see total reserves, but not who deposited.
2. We publish a **Merkle-sum tree of all user balances**, and each user checks their own balance is in it.
3. Reserves ≥ liabilities, and anyone can verify both halves.

That's provable solvency on a privacy chain, with depositors staying private. It's the trust answer, and it's also the headline.

**Legal:** a custodial venue for a privacy coin is your call, not an engineering question. Get counsel before mainnet, and geofence however they advise.

---

## 10. The one UX gap left

**The first deposit waits ~4 minutes.** After that, everything matches pump.fun: create in seconds, trade in milliseconds, charts move live.

Mitigations: a pending-deposit screen with a live confirmation count, and letting users browse, draft a token, and queue their first buy while funds confirm.

---

## 11. Optional: auction launches

Keep v1's uniform-price auction as a **"fair launch" mode** for big drops. The market data says the big money on Zcash is event-shaped: zkSNARKs cleared ~12,000 ZEC in one auction, while the busiest token has $531 of lifetime trading. The default is the instant curve, with the auction available for launches that want a zkSNARKs-style event.

---

## 12. Build plan

1. ✅ **Engine + parity harness** (done 2026-09-26, see [zec/README.md](../zec/README.md)). Ledger, sequencer, the curve/graduation/AMM port, fees, and differential tests against the Solidity contracts: 8,640 ops, 72 graduations, zero divergence. A narrated CLI demo runs a full launch on ZEC parameters (`node zec/demo.ts`).
2. **Zcash testnet rails.**
   - ✅ **2a** (done 2026-09-26). Deposit/withdrawal lifecycle in the engine, a durable hash-verified log, and rails tested against a simulated chain with reorgs, expiries and crashes (47 tests). There's also a live dependency-free lightwalletd client (tip, blocks, tx lookup, broadcast), verified against testnet.zec.rocks.
   - ✅ **2b** (live on testnet 2026-09-26). `zec/wallet-service` is a librustzcash treasury wallet on Railway, in its own project. It creates the treasury account in-container, syncs from testnet.zec.rocks, hands out Orchard deposit addresses, and scans the Orchard, Ironwood and Sapling pools. The rails run against it through `rails/http-wallet.ts`. **Verified end to end on testnet 2026-09-26** (`node zec/rails/e2e.ts`):
     - a 0.1 TAZ deposit was credited at 3 confirmations and traded while still immature (a token launch, a buy and a sell), then became withdrawable at 10;
     - a 0.03 TAZ withdrawal was built, proved, broadcast (txid `b3a27974…136c`) and settled at 10 confirmations;
     - the books balance to the zatoshi. The faucet's coins arrived in the **Ironwood** pool, which is why the wallet scans all three pools.
3. ✅ **Web** (first cut 2026-09-26). `zec/server` serves the engine plus rails over HTTP with Ed25519-signed accounts and a live SSE stream. `web/app/zec/*` (moved to the site root when ZEC took over the repo) held the Market, Token (market-cap candles plus instant trade panel), Launch and Account (deposit address, withdrawals, key backup) pages. It's verified in a real browser against the sim server: a WebCrypto-signed faucet, launch, buy and live stream. **Not yet:** hosting the API (it needs one always-on process next to the log), a mobile pass, token images beyond URLs, and the step-4 solvency features.
4. **Solvency.**
   - ✅ **Phase A** (live 2026-09-26). A Merkle-sum liabilities tree over every balance, with `/api/solvency` and per-user proofs re-verified in the browser. Also a per-account withdrawal limit of 50 ZEC per rolling day.
   - ✅ **Phase B** (live on testnet 2026-09-26). The wallet is now two accounts:
     - **treasury** owns the deposit addresses and keeps its viewing key private;
     - **reserve** holds the funds, pays every withdrawal, and publishes its viewing key at `/api/audit`.
     
     The rails sweep the treasury into the reserve once 0.01 ZEC is spendable there. Withdrawals discard their outgoing viewing data, so the public key shows value leaving but not where it went. Every hour, when the log has moved, the rails write `uwzec:anchor:v1:<length>:<head>` into a reserve memo, readable by anyone holding the key. Sweeps and anchors are engine commands recorded before broadcast; their network fees are paid from protocol fees at finality.
     
     First live run: sweep of the testnet float settled, then anchor `4b0464e5…6bf9` at log #11.
   - **Not yet:** FROST cold storage (who holds the shares is a decision for you), and lazy ZRC-20 deploy plus token withdrawals.
5. **Mainnet with deposit caps**, raised as the system proves itself.

**2026-09-26: ZEC is the whole project.** The Ink and Robinhood launchpad is retired and archived at [kaleidofinance/underwater-evm](https://github.com/kaleidofinance/underwater-evm). This repo keeps only its launchpad and DEX contracts, as the parity reference in `zec/parity/reference`. The web app serves ZEC at the site root, badged testnet until mainnet.

**2026-09-27: token taxes.** Creators earn through a tax they set on their own token at launch, fixed for its life and separate from the protocol's fees. The protocol's fees stay fixed and all the protocol's: 1% on curve trades, 0.5% on pool trades after graduation (`ammFeeBps`), 5% of a graduation raise and 0.001 ZEC to create.

A tax has a buy rate and a sell rate (each 0–10%, `MAX_TAX_BPS`), charged on the ZEC side of every trade on the curve and in the pool. Its split must total 100%, across four destinations:
- **creator:** into the creator's balance;
- **dividends:** to every holder, pro rata, through a dividends-per-token accumulator, so later buyers never share earlier dividends and a trader never collects from their own trade's tax;
- **buyback:** buys the token from its pool and burns it;
- **liquidity:** added to the pool.

Buyback and liquidity collected on the curve wait in reserve accounts and land in the pool at graduation. The launch screen offers presets (Creator-backed 1% to the creator, Diamond hands 3% to dividends, Deflationary 3% to buyback, Auto-LP 3% to the pool) or a custom split.

Uncollected dividends and the waiting reserves are published as aggregate leaves in the proof of liabilities. Every tax event is emitted only for taxed tokens, so untaxed history replays to the same hashes. (An earlier same-day version paid creators half of the protocol's own fees; the live testnet log switched that back off with one logged `setCreatorShareBps(0)`.)

**2026-09-27: token images.** Launches upload their image to the API (`POST /api/images`, signed). Images are content-addressed on the API's volume under a 150 MB cap and a per-account daily quota, and served with a sandboxing CSP. Only PNG, JPEG, GIF and WebP pass, checked by magic bytes. The browser re-encodes stills to 512 px, which strips EXIF location data. A launch may only reference an image we host, so no outside host sees who views a token.

Step 1 can start today and needs nothing from anyone.

---

## 13. Decisions for you

1. **Custody and legal posture.** This is now unavoidable for the whole product, not only bids.
2. **`V`.** 1.5 ZEC recommended (graduation ≈ $57.5K FDV).
3. **Confirmation thresholds.** 3 to trade, 10 to withdraw, recommended.
4. **Which ZRC-20 for token withdrawals.** Low stakes now that trading is internal, so defer until step 4.
