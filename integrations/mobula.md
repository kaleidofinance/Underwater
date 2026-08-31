# Mobula

Everything a third-party indexer needs to list underwater.fun, written for
[Mobula](https://mobula.io) specifically because they are the first data provider whose
coverage actually fits this protocol.

**Status: ready to send, waiting on a mainnet deploy.** Mobula supports Ink Mainnet
(57073) and Robinhood Chain (4663) across all five of their products — Market API, Wallet
API, Streams, Swap API, Metadata — and neither Ink Sepolia (763373) nor Robinhood Chain
Testnet (46630) is on their chain list. Everything underwater.fun runs today is on those
two testnets, so there is nothing for them to index yet. This document is the packet, not
a request already made.

## Why them and not DexScreener

DexScreener and GeckoTerminal index DEX pairs. Our DEX is an in-house V2 fork they have
written no adapter for, and more importantly a launchpad token spends most of its life
*on the curve*, where there is no pair to index at all — so a listing there would be
blank for exactly the tokens people are looking at. Mobula indexes bonding curves
deliberately and documents thirteen existing launchpad integrations on Robinhood Chain
alone. That is the difference that makes this worth doing.

What it does not change: our own indexer (`indexer/`, Ponder) stays the source of truth
for the app. Curve progress, uwPoints and the protocol fee ledger are questions only we
can answer, and the price a trade form quotes against should not come from a third party.
Mobula is distribution.

## Addresses

Per-chain deploys, to be filled in when mainnet ships. The canonical values live in
`web/.env.local` and in `broadcast/`; they are deliberately not committed, so treat this
table as the shape rather than the source.

| | Ink Mainnet | Robinhood Chain |
| --- | --- | --- |
| Chain id | 57073 | 4663 |
| Stack | OP Stack | Arbitrum Nitro |
| Block time | ~1 s | ~0.10 s |
| `UnderwaterLaunchpad` | not deployed | not deployed |
| `UnderwaterFactory` | not deployed | not deployed |
| `UnderwaterRouter` | not deployed | not deployed |
| WETH | `0x4200000000000000000000000000000000000006` | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Explorer | explorer.inkonchain.com | robinhoodchain.blockscout.com |

Two chain-level notes worth passing on. Robinhood Chain has no OP Stack WETH predeploy —
its WETH is an ordinary deployment, and an EIP-1967 proxy at that (implementation
`0xc6B81B429797E0f555440b70Cd99E032D7Ae947E` as of 2026-08-30), so a `code`-based
sanity check on it will not find the WETH9 selectors. And at tenth-of-a-second blocks a
backfill from genesis is millions of empty blocks; start from the launchpad's deploy
block.

## Events

Three events describe a launch's whole life. Signatures are exact and the hashes are
`keccak256` of the string shown.

**`TokenCreated`** — `0x91891eee2488475580e3ecb4c5bf5c89e7d3a3e4933f9ec22456f0cc7ffa16f9`

```solidity
event TokenCreated(
    address indexed token,
    address indexed creator,
    string name,
    string symbol,
    string metadataURI,
    uint256 timestamp
);
```

**`Trade`** — `0x716219e4eb0704ac5671e8c7720dc9c7a6b03d4070209ecd25cfe56a94e81a33`

```solidity
event Trade(
    address indexed token,
    address indexed trader,
    bool isBuy,
    uint256 ethAmount,
    uint256 tokenAmount,
    uint256 feeAmount,
    uint128 ethReserve,      // post-trade
    uint128 tokenReserve,    // post-trade
    uint128 realEthRaised,   // post-trade
    uint256 timestamp
);
```

The reserves are carried on purpose: price, market cap and graduation progress are
derivable from the log with no follow-up call. Two things to get right.

- **The reserves are post-trade**, so the price derived from them is the price *after*
  the fill, not before.
- **`ethAmount` is net of the fee on a buy and gross of it on a sell.** A buy emits
  `grossEthIn - fee` — what actually entered the curve — while a sell emits the gross ETH
  the curve gave up, of which the trader receives `ethAmount - feeAmount`. `feeAmount` is
  the protocol's cut either way. Our own volume figure sums `ethAmount`, so matching us
  means doing the same rather than normalising one side.

**`Graduated`** — `0x8d0453dc55ff49f0c8c7ca816943faff3ced84a6a1a9b3831f8bcf12b4d700c3`

```solidity
event Graduated(
    address indexed token,
    address indexed pair,
    uint256 ethLiquidity,
    uint256 tokenLiquidity,
    uint256 protocolFee,
    uint256 timestamp
);
```

There is also `GraduationFailed(address indexed token, uint256 raised)`
(`0x1421356910365e73b9a56c122801a4c5788705dcfc3295d97725178fbddb456e`), emitted when the
liquidity deposit declines and the curve parks at the threshold awaiting a retry through
`graduate(address)`. A curve in that state is fully funded but still trading; it is not a
dead token.

## The curve

Constant product against *virtual* reserves — the curve behaves like a V2 pool seeded
with liquidity nobody owns, so the first buyer pays a finite price and the curve is smooth
to graduation. All values are `constant` in the contract:

| | |
| --- | --- |
| `TOTAL_SUPPLY` | 1,000,000,000e18 |
| `CURVE_SUPPLY` | 800,000,000e18 (sellable on the curve) |
| `LP_SUPPLY` | 200,000,000e18 (seeds the pool) |
| `VIRTUAL_ETH_RESERVE` | 1 ether |
| `INITIAL_TOKEN_RESERVE` | 1,000,000,000e18 |
| `GRADUATION_ETH` | 4 ether of real ETH raised |

`x = ethReserve` (virtual seed + real ETH in), `y = tokenReserve`, `k = x·y`. Buying takes
`dy = y·dx/(x+dx)`, selling returns `dx = x·dy/(y+dy)`, and every function rounds toward
the pool. The marginal price, scaled by 1e18, is simply

```
spotPriceE18 = ethReserve · 1e18 / tokenReserve
```

Because 4 ETH raised puts `x` at 5 and `y` at 1e9/5 = 2e8, the ETH threshold and the
800M token ceiling bind at the same instant. The final curve price is therefore always
`5e18/2e8` = 2.5e10 wei per whole token — 25 ETH fully diluted.

**Expect a price step down at graduation, and do not read it as a crash.** The pool opens
with `ethLiquidity` — the raise minus the graduation fee — against `LP_SUPPLY`, which at
a 5% fee is 3.8 ETH against 200M tokens, or 1.9e10 wei per token. That is 76% of the
curve's last marginal price. Most of the gap is structural rather than fee: the virtual
1 ETH was never real liquidity, which on its own puts the pool at 4/5 of the curve's
final price, and the graduation fee takes the remaining 5%. It is one discontinuity per
token, at a known instant, and a naive OHLCV series will draw it as a −24% candle.

## Views

Read-only, on the launchpad, all reverting `UnknownToken()` for an address it never
launched:

| Call | Returns |
| --- | --- |
| `pools(address)` | `(ethReserve, tokenReserve, realEthRaised, tokensSold, creator, createdAt, graduated, exists)` |
| `spotPriceE18(address)` | marginal price, wei per whole token, ×1e18 |
| `progressBps(address)` | 0–10000; returns 10000 once graduated |
| `marketCapEth(address)` | FDV in wei at the marginal price |
| `quoteBuy(address, uint256)` | `(tokensOut, fee, refund)` — mirrors `buy` exactly |
| `quoteSell(address, uint256)` | `(ethOut, fee)` |
| `tokenCount()` / `tokensSlice(start, count)` | the full launch list, in creation order |

`tokensSlice` exists for exactly this: a backfill can enumerate every launch without
scanning a single log. Note that `marketCapEth` multiplies by the `TOTAL_SUPPLY`
constant, which is right up to graduation; afterwards read `totalSupply()` on the token,
because unsold curve tokens and any LP remainder are burned at graduation and the float
genuinely shrinks.

## Graduation and the pool

**It is a Uniswap V2-style pair, not a V3 pool.** Price comes from the reserve ratio, not
from `sqrtPriceX96`, and there is no tick data or fee tier. `UnderwaterFactory` and
`UnderwaterPair` are a V2 fork with the standard surface — `Sync(uint112,uint112)`,
`Swap(address,uint256,uint256,uint256,uint256,address)`, `Mint`, `Burn`, `getReserves()`,
`token0()`, `token1()` — plus TWAP accumulators. Swap fee is 0.3% (`amountIn * 997 /
1000`), of which the protocol takes a sixth as LP tokens minted to `feeTo` at the next
liquidity event.

Three ordering facts, all measured rather than assumed:

- **Prefer `Graduated` over the factory's `PairCreated`** for discovering launch pools.
  The factory is a public AMM, so anyone may create a pair on it and `PairCreated` would
  enrol pools with no launch behind them. `Graduated` names the pair explicitly.
- **`Mint` and `Sync` are emitted before `Graduated`**, in the same transaction — the
  launchpad adds liquidity and then announces it. A pair's first reserves can arrive
  before anything says which token it belongs to.
- **`Sync` precedes `Swap`** within a swap transaction, so post-swap reserves are already
  known when the `Swap` log is read.

The LP receipt goes to `0x000000000000000000000000000000000000dEaD` and is never held by
anyone, so the pool's liquidity cannot be pulled. That is a fact worth surfacing in a
risk or trust panel, since it is the usual thing such panels look for.

## Metadata

`metadataURI` arrives in the `TokenCreated` log and is also a public string on the token
itself — `MemeToken.metadataURI()` — so it survives without log access. The launchpad
stores it and never looks at it: it may be an `ipfs://` URI, a `data:` URI, an https URL,
and it may point at an image directly or at a JSON document naming one. Nothing about it
is trusted, since it comes from whoever launched the token.

When it resolves to JSON, these are the keys the app honours, first match winning:
`image` / `image_url` / `imageUrl`, `banner` / `banner_url` / `bannerUrl`, `name`,
`description`, `website` / `external_url` / `externalUrl`, `twitter` / `x`, `telegram`,
`discord`.

## Fees

Four legs, three of them owner-settable per deploy, so read them from the chain rather
than hard-coding: `tradeFeeBps()`, `creationFee()`, `graduationFeeBps()`. The ceilings
*are* constants and cannot be raised: `MAX_TRADE_FEE_BPS` 200 (2%), `MAX_GRADUATION_FEE_BPS`
1000 (10%), `MAX_CREATION_FEE` 0.01 ether. The fourth leg is the DEX's own 1/6 of 0.3%,
gated by `UnderwaterFactory.feeTo()`, and it is inert while the graduation LP is burned —
`feeTo`'s claim mints at the next liquidity event, which for a burned position never
comes.

## Next steps

Onboarding is a conversation, not a form: Telegram, Slack or Discord, or
contact@mobulalabs.org. When mainnet is live, the packet is this file plus the addresses
in the table above, and the two things to raise explicitly are the V2-not-V3 graduation
and the price step at the hand-over — both are places a generic launchpad adapter would
quietly produce a wrong number.
