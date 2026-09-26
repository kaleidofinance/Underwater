# Underwater ZEC — market data & revenue model

**Measured:** 2026-09-26, from Zerdinals' own APIs (`token-api.zerdinals.com`, `market-api.zerdinals.com`) and CoinGecko.
**ZEC:** $1,533.95 · market cap $26.0B · 24h spot volume $897M.

Companion to [underwater-zec.md](underwater-zec.md).

---

## 1. The finding in one line

**Demand for Zcash-native tokens is event-shaped, not flow-shaped.** People show up in size for primary issuance and do almost no secondary trading. That is the opposite of pump.fun, whose revenue is a cut of continuous flow.

---

## 2. Supply side: token creation already exists, and mostly dies

All 152 ZRC-20 tokens on Zerdinals (the only live implementation):

| Metric | Value |
|---|---|
| Tokens deployed | **152** (149 on Sep 22 → +3 in four days) |
| Distinct deployers | 102 |
| Fully minted | 35 |
| Still minting / abandoned | 117 |
| **Median holders** | **1** |
| Tokens with ≤ 2 holders | **127 (84%)** |
| Tokens with ≥ 10 holders | 12 |
| Tokens with ≥ 100 holders | 5 |

Deploys by month:

| 2025-11 | 2025-12 | 2026-01 → 04 | 2026-05 | 2026-08 | 2026-09 (to 26th) |
|---|---|---|---|---|---|
| **109** | 2 | **0** | 26 | 2 | 13 |

72% of all tokens were deployed in the launch month. Then four months of nothing. Activity comes in bursts that track ZEC price and narrative, not a steady creator base.

The five tokens that got past 100 holders: `zero` 2,267 · `zecs` 980 · `pepe` 553 · `zats` 401 · `zodl` 166. All deployed Nov 13–17 2025. Nothing deployed since has reached 100.

**Read:** "anyone can create a token on ZEC" is not an unmet need. 102 people have done it. What is missing is any reason for anyone *else* to buy — i.e. price discovery and a market.

---

## 3. Demand side: secondary trading is effectively zero

The Zerdinals marketplace lists **one** of 152 tokens: `zero`, the most-held ZRC-20 in existence.

| `zero` market, all time | |
|---|---|
| Listings created | 57 |
| Listings withdrawn | 31 |
| **Sales** | **5** |
| **Lifetime volume** | **0.3463 ZEC ≈ $531** |
| First sale ever | 2026-09-20 |

Every sale:

| Date | ZEC | Tokens |
|---|---|---|
| 2026-09-20 | 0.0013 | 50 |
| 2026-09-20 | 0.131 | 8,000 |
| 2026-09-23 | 0.015 | 5,000 |
| 2026-09-23 | 0.18 | 62,000 |
| 2026-09-24 | 0.019 | 10,000 |

Zero trades in the ten months before the NFT wave. All five landed in the week zkSNARKs cleared. Sell interest (57 listings) outnumbers completed buys eleven to one.

**Caveat, and it matters:** this measures demand *under the current UX* — a static listing board, transparent t1 browser wallets, one listed asset. Nobody has tested whether a real market with price discovery changes the answer. That unknown is precisely the bet.

---

## 4. The one hard demand datapoint

zkSNARKs blind auction, cleared 2026-09-19:

| | ZEC | USD today |
|---|---|---|
| Total bid | 25,305 | $38.8M |
| Refunded | 13,309 | $20.4M |
| **Cleared** (8,000 × 1.5) | **~12,000** | **$18.4M** |

16,971 bids for 8,000 units. Serious capital shows up for a Zcash-native primary event — and it did so for an auction, which is the mechanism in the spec.

---

## 5. Revenue model

**Levers** (from the spec):

- **Primary clearing fee:** 1.5% of cleared ZEC per epoch
- **Launch fee:** 0.05 ZEC. This also answers the spec's open ticker-squatting question.
- **Secondary call-market fee:** 1% of cleared value, post-graduation

```
monthly ZEC = cleared_primary × 1.5%  +  launches × 0.05  +  cleared_secondary × 1%
```

Three scenarios at $1,534/ZEC. **These are illustrative inputs, not forecasts** — only the bear row is anchored in measured data. Plug in your own.

| | Bear | Base | Bull |
|---|---|---|---|
| Premise | Current ZRC-20 reality persists | We capture real share of the NFT-wave energy | Base + one zkSNARKs-scale event per quarter |
| Launches / mo | 10 | 60 | 60 |
| Primary cleared / mo | 50 ZEC (avg 5 per launch) | 858 ZEC (1 × 500, 5 × 50, 54 × 2) | 858 + 4,000 amortised |
| Secondary cleared / mo | 0 | 86 ZEC (10% of primary) | 86 ZEC |
| **ZEC / mo** | **1.25** | **16.7** | **76.7** |
| **USD / mo** | **≈ $1.9K** | **≈ $25.7K** | **≈ $118K** amortised |

The bull row is lumpy in practice: the event month alone clears 180 ZEC (≈ $276K), then the next two months fall back to base.

### What moves the answer

1. **Hits, not count.** In the base case, one 500-ZEC launch is 58% of primary revenue. Revenue is a power law over launches, and the business is getting the few that matter, not the long tail. 127 of 152 existing tokens never found a second holder.
2. **Secondary is the pump.fun lever, and it has no evidence yet.** $531 lifetime on the flagship token. If a real market doesn't change that, the business is an event venue with occasional big months.
3. **Everything is ZEC-denominated and pro-cyclical.** ZEC went ~$200 → $1,534 in a year, and the NFT wave followed the price. A reversal cuts USD revenue *and* demand at the same time. The bear case most likely coincides with a ZEC drawdown.
4. **The bear case doesn't cover a custodial venue's legal review.** Running a full node plus indexer is cheap; counsel on holding third-party ZEC is not.

---

## 6. What this means for the product

- **Build primary-clearing-first.** The fee that matters is on launches, which is the opposite of pump.fun's trading-fee-first model. The call-auction spec already fits: a launch is an event.
- **Launch quality beats launch count.** Consider featured or curated launches alongside the open ones. The long tail doesn't pay, and it pollutes discovery.
- **Treat secondary as the experiment, not the plan.** Ship the call market, then measure whether it produces flow where the listing board didn't. Don't model the business on it until it does.
- **The pons comparison needs care.** pons won on an EVM chain where flow existed and only UX was missing. On Zcash the flow itself is unproven, so being first buys a position in the event market, which is real but smaller and lumpier.
