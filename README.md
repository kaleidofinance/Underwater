# underwater.fun

A permissionless meme token launchpad for [Ink](https://inkonchain.com), Kraken's OP Stack L2.

Anyone launches a token for free. It trades against a bonding curve with no
seed liquidity required. Once the curve raises 4 ETH the launch "graduates":
the contract deposits the raise plus a reserved token allocation into a real
DEX pool and **burns the LP tokens**, so the liquidity can never be pulled by
the creator, the protocol, or anyone else.

The repo ships **its own constant-product DEX** ([`src/dex/`](src/dex)) for
graduated tokens to trade on, so the launchpad does not depend on a third-party
deployment existing, staying solvent, or staying honest. It is ABI-compatible
with Uniswap V2, so pointing the launchpad at somebody else's V2 router instead
is a one-line config change either way.

It also ships **Underwater** ([`src/nft/`](src/nft)) — a 2222-piece NFT
collection whose art is a live rendering of the holder's own leveraged Aave
position, and which can be burned out from under them when that position
liquidates. It is **fully on-chain**: no `baseURI`, no IPFS, no image server. The
picture is composed in Solidity at the moment you read `tokenURI`, because it
depends on the position's health factor *right now*. See
[the collection](#underwater--the-2222-plates) below. It shares nothing with the
launchpad but the repo and the utils.

**Status: contracts complete and tested, including the collection's on-chain
renderer — every plate is composed in Solidity and pinned byte-for-byte against
the Python original. A working frontend lives in [`web/`](web) — nothing is
deployed to a live network and there is no indexer yet. See
[Not built yet](#not-built-yet) for what remains.**

---

## The curve

A constant-product curve priced against *virtual* reserves — the same shape as
a Uniswap V2 pool seeded with liquidity nobody owns.

```
x = ethReserve    (virtual seed + real ETH paid in)
y = tokenReserve  (virtual ceiling - tokens sold)

buy:  tokensOut = y·dx / (x + dx)
sell: ethOut    = x·dy / (y + dy)
```

The virtual ETH seed is what gives the very first buyer a finite entry price
instead of a division by zero.

| Parameter | Value |
|---|---|
| Total supply | 1,000,000,000 |
| Sellable on the curve | 800,000,000 |
| Reserved for the DEX pool | 200,000,000 |
| Virtual ETH reserve (`x₀`) | 1 ETH |
| Initial token reserve (`y₀`) | 1,000,000,000 |
| Graduation threshold | 4 ETH (net of fees) |

These numbers are not arbitrary. Draining the curve raises exactly the
threshold:

```
raise(S) = x₀·S / (y₀ - S) = 1 ETH × 800M / 200M = 4 ETH
```

so the two exit conditions — "800M tokens sold" and "4 ETH raised" — bind at
precisely the same instant, and the virtual token floor (`y₀ - S = 200M`)
equals the LP allocation. Both identities are asserted as tests
([CurveMath.t.sol](test/CurveMath.t.sol)); if you change one parameter the
suite fails until the set is consistent again.

Marginal price runs from 1 gwei to 25 gwei per token — a **25× move** from
launch to graduation, with FDV going 1 ETH → 25 ETH.

**Rounding always favours the pool.** Every division truncates against the
trader, so `k` can only grow. A full unwind leaves the curve a few wei
*over*-collateralised rather than short, which is the safe direction.

## Lifecycle

1. **`create`** deploys a fixed-supply [`MemeToken`](src/token/MemeToken.sol)
   and opens its curve. Any ETH sent beyond the creation fee is spent as the
   creator's own first buy *in the same transaction* — which is the only way to
   be first, removing the incentive to snipe your own launch from a second
   address.
2. **`buy` / `sell`** trade against the curve. Both take a slippage bound and a
   recipient. `quoteBuy` / `quoteSell` mirror the execution path exactly,
   including the final-buy size-down, so the UI can show the true fill.
3. **Graduation** fires automatically inside the buy that crosses 4 ETH. The
   crossing buy is **sized down to land exactly on the threshold and the
   remainder refunded**, so nobody is charged for tokens the curve can't sell.
   Then: 200M tokens + the raise (minus the protocol cut) go into a V2 pool
   (ours by default — see below), LP tokens go to `0x…dEaD`, unsold tokens are
   burned, and the curve closes permanently.

### The graduation gas floor

The liquidity deposit is wrapped in `try`/`catch` so a broken or hostile router
cannot brick the buy that crosses the threshold — the curve parks at 4 ETH and
`graduate()` can be retried. That safety net has a sharp edge, and
`GRADUATION_GAS_RESERVE` is what blunts it.

Because the deposit is caught, a deposit that merely *runs out of gas* still
leaves the transaction successful. `eth_estimateGas` binary-searches for the
cheapest gas limit that does not revert, so it finds the limit that skips the
deposit. Every wallet-estimated final buy would have parked the curve at the
threshold instead of graduating it — on a perfectly healthy router, every time.
Nothing lost, but the headline moment of a launch would have needed a manual
follow-up call. This is only visible against a real node: with an explicit gas
limit, as every test and every `forge script` run uses, it never reproduces.

The fix is a floor, not a guess:

```solidity
if (gasleft() < GRADUATION_GAS_RESERVE) revert GraduationOutOfGas();
```

checked before any state moves. Reverting below the floor forces the estimate
*upward* until the deposit provably fits, so reaching `catch` now genuinely
means the router declined on its own terms. Seeding a fresh pair on our own DEX
measures ~2.2M gas against a 3M floor, and the reserve is [bounded from both
sides in the tests](test/dex/LaunchpadOnUnderwaterDex.t.sol) — above the real
cost, and not so far above that it taxes the final buyer.

A one-level EIP-150 heuristic (`gasleft() < G/63` after the catch) was tried
first and is wrong: a *nested* out-of-gas lets the router keep its own retained
1/64 and revert cheaply, leaving ~G/32. The regression test that killed it,
[`test_everyGasLimitThatSucceedsAlsoGraduates`](test/Graduation.t.sol), sweeps
gas limits and asserts the invariant directly — any limit at which the buy
succeeds is a limit at which the token graduated.

## The DEX

Graduated tokens land in a pool on our own DEX: a constant-product AMM in
[`src/dex/`](src/dex), ported from Uniswap V2 to Solidity 0.8.26.

```
UnderwaterFactory   CREATE2 pair registry; owner's only power is setFeeTo
UnderwaterPair      reserves, swap maths, TWAP accumulators, LP token
UnderwaterRouter    front door: wraps ETH, slippage, deadlines, multi-hop
```

**Why our own.** Ink Sepolia has no V2 DEX at all, so without this the full
system could not be exercised on the testnet — only against a mainnet fork. It
also removes a dependency whose liquidity, fee switch and upgrade keys belong to
someone else, and keeps the trading fees inside the protocol instead of paying
them out to a third party.

**Why a V2 port and not something new.** The V2 core is the most heavily
attacked and most heavily audited AMM ever deployed. Swap maths, fee split,
reserve packing, price accumulators and event signatures are unchanged —
deliberately. Unchanged events also mean any V2 indexer, charting tool or
arbitrage bot already speaks to our pools, and the flash-swap callback keeps the
V2 name `uniswapV2Call` for exactly that reason.

**The one real porting risk.** Solidity 0.5 wrapped silently; 0.8 reverts. V2
relies on wrapping in precisely two places, both inside `_update`:

1. `timeElapsed = blockTimestamp - blockTimestampLast` — must wrap, or every
   swap reverts forever after the uint32 rollover in 2106 and the pool freezes.
2. The two `price*CumulativeLast` accumulators — must wrap, because a TWAP is
   read as a *difference* between two snapshots, which stays correct across any
   number of overflows.

Everywhere else the original used SafeMath, so 0.8's checked arithmetic
reproduces it exactly. Marking too little bricks the oracle; marking too much
hides a real overflow. Both sites are `unchecked` with the reasoning at the
line, and — more to the point — asserted directly in
[PairOracle.t.sol](test/dex/PairOracle.t.sol), including warping past 2106 and
parking an accumulator near `type(uint256).max` to force a wrap.

**No init-code-hash footgun.** The usual way a V2 fork breaks is
`pairFor()` recomputing the CREATE2 address from a hard-coded init code hash
copied from Uniswap — it silently points at an address where no pool lives.
[`UnderwaterLibrary.pairFor`](src/dex/libraries/UnderwaterLibrary.sol) reads the
factory registry instead and reverts `PairNotFound` if there is no pool. The
real hash is published on-chain as `factory.pairInitCodeHash()` for off-chain
use, and a test derives the live pair address from it.

**Fees.** 0.3% per swap to LPs. The protocol fee switch is **off** at deploy, so
early pools pay 100% of the fee to liquidity. Switched on, `feeTo` receives 1/6
of the growth in `sqrt(k)` — 0.05% of volume out of the 0.3% — minted as LP
tokens on liquidity events, never skimmed per swap. Turning it off clears
`kLast`, so it cannot bill retroactively for growth accrued while off.

One non-obvious consequence: a graduated pool has **100% of its LP burned**, so
no ordinary liquidity event ever settles the accrued protocol fee there. It is
not lost — adding a dust position triggers settlement and mints everything owed.
Demonstrated in
[`test_protocolFeeIsHarvestableEvenThoughAllLpIsBurned`](test/dex/LaunchpadOnUnderwaterDex.t.sol).

**Trust surface.** The factory owner can call `setFeeTo` and nothing else. No
pause, no blocklist, no per-pair fee override, no upgrade path. The router is
ownerless, immutable, and holds no balance between calls (asserted).

**Licensing.** `src/dex/**` is GPL-3.0-or-later because it derives from Uniswap
V2. The launchpad and token stay MIT, which GPL permits.

## Launchpad fees

| Fee | Default | Hard cap in code |
|---|---|---|
| Trade fee (on the ETH leg, both directions) | 1% | 2% |
| Creation fee | 0 | 0.01 ETH |
| Protocol cut of the graduation raise | 5% | 10% |

The caps are `constant` and enforced in the constructor *and* every setter. The
owner cannot exceed them — see [`test_feeCeilingsAreEnforced`](test/Launchpad.t.sol).

## Underwater — the 2222 plates

A separate product in the same repo: [`src/nft/`](src/nft). Nothing in the
launchpad or the DEX imports it, and it imports nothing from them.

2222 hydrographic survey plates. Each plate can be attached to its holder's own
Aave V3 position, after which the art is driven by that position's health
factor: crisp ink at the surface, dissolving into ink plumes as the health factor
falls, gone when it liquidates.

| Mechanic | Who can call it | What happens |
|---|---|---|
| `dive(id)` | holder only, on their own position | plate starts tracking `msg.sender`'s health factor |
| `surface(id)` | holder only | detaches; scars already engraved stay |
| `scar(id)` | **anyone**, when HF < 1.4 | engraves a permanent near-death mark. Rate-limited to one per day per plate, capped at 8 |
| `drown(id)` | **anyone**, when HF ≤ 1.0 | **burns the plate** and mints the caller an engraved `UnderwaterTrophy` kill plate |

The cruelty is the mechanic, not a side effect: a stranger can permanently
destroy art whose owner got liquidated, and keep a trophy engraved with the
loss. `surface` is the holder's only defence, and it has to be used *before* the
position goes bad.

**There is no custody and no lending.** The contract reads
`IAavePool.getUserAccountData` and nothing else. It holds no token approval,
moves no collateral, and cannot liquidate anybody — it can only notice. `dive`
binds `msg.sender` and never takes an address parameter, so a holder cannot
point a plate at a stranger's position and get it drowned over a loss its owner
never took. Transfers auto-surface the plate, so a seller cannot drown art they
no longer own by letting their own position go bad.

**The art is pre-committed, and assigned after minting closes.**

1. Traits are generated off-chain (rejection-sampled for uniqueness, so they
   cannot be derived from `tokenId` on chain), packed 10 categories × 4 bits =
   40 bits per plate, 6 plates per 256-bit word, 371 words.
2. `keccak256(abi.encode(table))` is fixed in the constructor as `provenance`
   and published before minting.
3. `commit` writes the table in batches; `seal` refuses to open minting unless
   what is in storage hashes to `provenance`. So the rarity distribution
   provably could not be tuned after demand was known.
4. `reveal` draws the offset mapping plate numbers onto table slots. It is
   permissionless and callable only once minting can no longer change the
   outcome — sold out, or past the deadline. A minter cannot see the offset
   before deciding to mint.

`reveal` uses `blockhash(block.number - 1)`, which on an OP Stack chain the
**sequencer** can influence by reordering. It cannot be influenced by a
*minter*, which is the attack this defends against. Anyone unwilling to trust
the sequencer should treat the distribution as sequencer-chosen, not random.

**Gold leaf is a pigment, not a rarity — decided.** The prototype's "22
aberrations" idea does not reach the chain: a packed plate is exactly 10
categories × 4 bits with no spare field, and gold leaf also rolls naturally at
weight 6, so **147 plates carry it** and the 22 intended ones are
indistinguishable from the rest. That is the intended distribution — 6.6% of the
collection, not a 1% tier. Making it aberration-only would have been a one-line
weight change in `traits.mjs` plus a regenerate, and the window for it closed
with the provenance hash; the table as generated keeps the prototype's
distribution unchanged.

**Collection parameters**

| | |
|---|---|
| Supply | 2222, ids 1..2222 in mint order |
| Allowlist phase | 2000 plates (`WL_ALLOCATION`), at `wlPrice` — targeting $10 |
| Public phase | whatever is left, at `price` (0.0222 ETH by default) |
| Treasury reserve | minted at `seal`, **0 at launch**, hard-capped at 222 (10%) |
| Max per transaction | `maxPerTx`, 22 at deploy, ceiling 222 |
| Max per wallet | `maxPerWallet`, allowlist phase only, 22 at deploy, **1 at launch**, ceiling 222 |
| Prices | **settable** by the owner, hard-capped at 1 ETH; payment must be exact |
| Mint window | **immutable** deadline, set at deploy; cannot be extended |
| Royalty | 5% to `treasury`, via ERC2981 |
| Aave pool | **immutable** — a settable risk source would be a lever over everybody's art; pinned per chain in [`script/InkAave.sol`](script/InkAave.sol) |
| `withdraw` | permissionless and hardcoded to `treasury`; cannot be redirected |
| Renderer | replaceable by the owner, given up permanently by `freezeRenderer` |

**The two phases.** The treasury reserve is set to 0 at launch, so 2000 of the
2222 go to the allowlist and the ~222 left to the public — but neither is an
earmark on specific plates. `WL_ALLOCATION` caps a *phase*, and whatever the
allowlist does not use rolls into the public mint. That is not generosity, it is
necessary: plates nobody can mint would keep the collection from ever selling out,
and `reveal` waits on selling out or on the deadline. (A non-zero reserve is
possible, capped at 222; at a 2000-plate allowlist it comes straight out of the
public ~222.)

Neither phase opens on its own. `seal` proves the art; `setMerkleRoot` opens the
allowlist; `openPublicMint` opens the public phase and is **one-way**, because a
buyer part-way through a mint should not have the phase shut under them. The
allowlist stays open once the public phase starts — an allowlist spot is a right
to the discounted price, and revoking it the moment the public mint opens would
punish whoever was slow.

**The allowlist is a Merkle root**, so 2000 addresses cost one storage slot
instead of 2000. [`src/utils/MerkleProof.sol`](src/utils/MerkleProof.sol) is
hand-rolled like every other util here, with two choices that matter:

- **Sorted pairs.** Each step hashes the two nodes in ascending order, so a proof
  carries only sibling hashes and no left/right flags — which is what
  `merkletreejs` with `sortPairs: true` and OpenZeppelin both produce, so a root
  from standard tooling verifies without translation.
- **Leaves are hashed twice.** `keccak256(keccak256(abi.encode(address)))`.
  Internal nodes are the hash of 64 bytes and leaves the hash of 32, so no
  address can be made to land on an internal node — the classic second-preimage
  attack. [There is a test](test/utils/MerkleProof.t.sol) that verifies an
  internal node *as* a leaf, to pin down why the second hash is there.

[`script/whitelist.py`](script/whitelist.py) builds the tree — against the
vendored Keccak, no dependencies — and writes both the root and one proof per
address for the mint page to serve. Proofs are public data and authorise nothing
on their own. The Solidity tests build the same tree independently and pin
themselves against that script's output, because a verifier tested only against
a tree built by its own rules will accept roots the real off-chain tooling would
never produce, and the symptom is an allowlist nobody can mint against.

**Getting onto that list starts on chain too.**
[`UnderwaterWaitlist`](src/nft/UnderwaterWaitlist.sol) is a third, independent
deploy — the plates contract does not know it exists, and it does not know about
the plates. It holds one function worth calling:

```solidity
function register() external;  // registers msg.sender, once, while the window is open
```

There is no owner, no admin, no setter and no second-party entry point: nothing
in it can register an address other than `msg.sender`, remove anybody, or move
the window, which is fixed in the constructor and immutable. [A test enumerates
the second-party selectors it deliberately doesn't have](test/nft/Waitlist.t.sol)
so that stays true if the contract is ever edited. Registrations are readable two
ways — the `Registered` event carries the position, so an indexer never has to
count, and `registrants(start, limit)` pages the same list out of storage for
anyone without one.

**This is intake, not the allowlist, and the page says so.** Registering costs
gas and nothing else, which means one person can register fifty addresses; the
waitlist makes no attempt to stop that. What it produces is a timestamped,
publicly auditable record of who applied and in what order — the input to a
selection made by [ALLOWLIST.md](ALLOWLIST.md), which is published *before
registration opens* and hashed on chain in a block earlier than the waitlist's own
deploy. That ordering is the only one that means anything: rules written after
seeing who showed up are not rules. The honest version of the rest is the one on
`/waterdrop` too — a registration is an application, not a spot, and being on this
list guarantees nothing.

**The criteria are a procedure, not a judgement.** 2000 plates at 1 per address is
2000 spots; if 2000 or fewer register, everybody is on it. Above that, the rank is
**qualified referrals** — how many wallets you brought in that were already *real* on
Ink at the waitlist's deploy block, where real is any one of a sent transaction, Aave
debt, or a prior launchpad trade (the union, not all three, so a smart-contract
wallet that never sends its own transactions still counts). A referral from a wallet
that was not real by then is worth nothing, which is the whole anti-sybil model: a
farm of fresh wallets buys draws in the tail lottery and zero rank. Ties, and
everyone the ranked do not reach, are settled by one seeded draw per address — the
seed is the hash of the first Ink block after the window closes, which does not exist
while registration is open, so nobody can register against it, and we cannot pick it
because we do not sequence Ink. Everything is a function of public data, so the root
we publish is reproducible by anyone who disagrees with it. What the document does
*not* claim — that it eliminates sybils, that it weighs anything off chain, that
arrival order is a rank — it says out loud, with what bounds each omission.

The four steps from a registration to a mintable proof:

| | | |
|---|---|---|
| 1 | `register()` on chain | while the window is open |
| 2 | `npm run waitlist` | exports `script/waitlist-snapshot.txt`, cross-checked against `count()` |
| 3 | `select.py --seed 0x… --launchpad 0x…` | applies ALLOWLIST.md, prints every draw, score and rank |
| 4 | `whitelist.py` → `SetWhitelist.s.sol` | tree, root, and the per-wallet limit in one go |

Step 2 pins a block number for every read and refuses to write a snapshot it
cannot reconcile. A short page mid-walk, a length that disagrees with `count()`, a
duplicate address, or an entry whose `standingOf` position isn't the index it
came back at — each of those aborts the export rather than producing a
plausible-looking list. It also does not filter, deliberately: intake and selection
are separate files so that the record of who applied stays checkable against the
chain on its own, without the selection folded into it.

Step 3 is the seam, and it prints its full workings — every registrant's draw,
qualified-referral score and rank, including the ones it did not take, which it keeps
as comments in the list it writes. It reads the referrer edges from the snapshot and
grades each referred wallet's qualification from public chain state at the deploy
block. Stdlib Python against the vendored `art/keccak.py`, for the reason
`whitelist.py` is: this decides who gets a discounted plate, and nobody checking it
should have to install anything first.

**One plate per address for the allowlist phase.** `maxPerWallet` ships at 22,
which fits the entire 2000-plate allocation inside 91 addresses — technically a
sold-out allowlist and practically a failure. At 1 it takes 2000 people, one plate
each, which is the point of the selection. The limit binds `mintWhitelist` only (the
public mint is bounded by `maxPerTx`), so tightening it costs nothing later and needs
no raise when `openPublicMint` runs. `SetWhitelist.s.sol` sets it in the same
broadcast as the root and sends the limit **first**: between two transactions the
allowlist is briefly live, and a few seconds of the tighter limit is harmless where a
few seconds of the looser one is not. `DeployPlates.s.sol` takes it too, because
`/waterdrop` quotes the number while registration is open and a collection sitting at
22 for a week tells everybody registering that the list reaches 90 people.

The renderer is a separate, replaceable contract because the asset markup alone
fills 77% of the 24KB code limit before any compose logic exists, and because
SVG filter support across marketplaces is inconsistent enough that shipping with
no way to fix a rendering bug would be the more reckless choice. It is the only
lever that touches the art rather than the launch, and `freezeRenderer` is how it
goes away.

**There is no folder of 2222 finished images, and there cannot be.** A plate's
picture is a function of its traits *and* the live health factor of the position
behind it, so it is composed on read — there is no `baseURI`, no IPFS pin and no
image server anywhere in the system. `tokenURI` returns a
`data:application/json;base64,…` document that the contract builds at the moment
you ask for it, with the SVG inside it. What is fixed is the ingredients:

- **44 drawn assets** in [`art/traits/`](art/traits) — one standalone SVG per
  option, plus `manifest.json` holding the anchors, transforms, palettes and
  dissolve constants that say how they compose. 18,819 B of markup total.
- **The trait table** in [`traits/`](traits) — which plate gets which options,
  hashed into `provenance` before anybody pays anything.

[`art/extract.mjs`](art/extract.mjs) produces the first by *evaluating* the
prototype's own drawing functions rather than re-typing their output, so the
files are byte-for-byte the markup the prototype draws — hand-copying 186 paths
would introduce drift nobody would notice until the art looked subtly wrong on
chain. [`art/render.py`](art/render.py) consumes both and composes any plate at
any health factor, which makes the whole collection regenerable from files at
any time:

```bash
node art/extract.mjs && cd web && npm run traits && cd .. && python art/render.py --all --hf 2.4
```

`render.py` is the off-chain twin of the on-chain renderer, so it is deliberately
constrained to what Solidity can mirror: a u32 mulberry32 verified bit-identical
to the JS original across 35 draws at 17 decimals, and a `toFixed` helper because
JS rounds half away from zero where Python rounds half to even. One gap is
recorded there rather than papered over — the prototype drew its per-plate
texture seed at random and never committed it, so `seed_for(id)` derives it
instead, and the Solidity port has to derive it identically or the two renderers
disagree.

### The on-chain renderer

[`src/nft/art/`](src/nft/art) is that port: the same 44 assets and the same
compose logic, in Solidity, returning the whole token URI from `eth_call`.

```
                                                          deployed runtime code
UnderwaterRenderer   compose, dissolve defs, metadata, Base64      17,871 B
UnderwaterFigures    diver, headgear, held, tether                 11,865 B
UnderwaterMarks      relics, emblems, card + stamp chrome          10,828 B
UnderwaterScenes     the five backdrops                             3,507 B
UnderwaterNames      trait labels and the attributes JSON           4,988 B
UnderwaterDissolve   the health-factor → filter-parameter curve     inlined
UnderwaterMath       fixed-point roots, decimal formatting, PRNG    inlined
```

**Why five contracts.** EIP-170 caps runtime code at 24,576 B and the minified
assets alone are ~17.8 KB, so they cannot share a contract with the compose
logic, the dissolve maths, Base64 and the JSON. The split is by how the renderer
uses them, not by size alone, so each external call fetches things that are
always needed together. The four asset contracts are **generated** by
[`art/solidify.py`](art/solidify.py) from `art/traits/**` through the same loader
`render.py` uses — so the bytes embedded in bytecode are byte-for-byte the bytes
the Python renderer composes. Transcribing 186 paths by hand would have produced
a typo in one of them that nobody noticed until a plate rendered wrong on a
marketplace.

**No floating point anywhere.** `render.py` was written under the constraint that
Solidity has no floats, so its output path is exact-rational throughout: draws are
carried as `num/den` and rounded exactly once, at the moment they are printed,
with `nearest(n,d) = (2n+d)/(2d)`. That discipline is the whole reason the Python
renderer can serve as a byte-exact oracle instead of an approximate reference.
One place needed a substitution rather than a port — the dissolve curve's `t^1.7`
has no closed form in fixed point, so both renderers compute `t^1.75` as
`sqrt(sqrt(t^7))`, which is two `sqrt` calls and visually indistinguishable.

**Dry dock is a sentinel, not a number.** A plate with no position attached is
`healthFactor == type(uint256).max`, which the renderer reads as "no position".
It cannot be spelled as a merely large health factor: 1e27 is above every band
boundary and would render as a perfectly crisp Surface plate, which is a
different claim.

**Differential testing is the point.** [`art/fixtures.py`](art/fixtures.py)
renders cases with the Python renderer and writes the results into
[`test/nft/fixtures/RenderFixtures.sol`](test/nft/fixtures/RenderFixtures.sol) as
a library the tests import — the real output, captured, not a second reading of
the spec, which could be wrong in the same way the implementation is wrong. The
fixtures are committed rather than fetched at test time because `foundry.toml`
sets `ffi = false` and grants no filesystem permissions, so `forge test` needs
neither a Python interpreter nor the ability to shell out. Hashing them needs
keccak-256 in Python, and `hashlib`'s `sha3_256` is the *NIST* variant with
different padding, so [`art/keccak.py`](art/keccak.py) vendors the Ethereum one
and is checked against known vectors.

Whole plates are pinned by `keccak256` of the token URI rather than embedded:
a composed plate is 3–22 KB of SVG base64'd inside the JSON, and 17 of them as
string literals would be 250 KB of unreadable blob. The digest is 32 bytes and
a single byte of drift anywhere — markup, metadata, or encoding — changes it. The
two states drawn from hand-written markup instead of generated assets (the sealed
tube and the drowned plate) are *also* stored whole, so the rows most likely to
hold a transcription typo print their bytes on failure instead of just a hash
mismatch.

Regenerate either half — the contracts or the fixtures — with one command each:

```bash
python art/solidify.py && python art/fixtures.py
```

[`UnderwaterTrophy`](src/nft/UnderwaterTrophy.sol) is deliberately inert, like
`MemeToken`: no owner, no pause, no upgrade, and one immutable minter (the
plates contract). Its art is generated **entirely on-chain** — a trophy records
something that happened, so it must not depend on a server staying up to keep
meaning what it meant at mint.

## Trust model

What the owner **can** do: change fees within the hard caps, change the fee
recipient, change the router for *future* graduations, and sweep ETH that is
not backing a live curve.

What the owner **cannot** do:

- Mint, pause, blacklist, or tax any token. [`MemeToken`](src/token/MemeToken.sol)
  has no owner and no mint function; supply is fixed at construction and only
  `burn` (which spends the caller's own balance) can change it.
- Touch trader funds. `sweep` is bounded by `totalCurveEth`, so it can only
  reach unaccounted dust — asserted in
  [`test_sweepCannotTouchCurveFunds`](test/Launchpad.t.sol).
- Withdraw graduated liquidity. The LP tokens are burned, not held.
- Raise fees past the caps, or hand ownership to a dead address (the handover
  is two-step).

On the DEX side the owner's entire authority is `UnderwaterFactory.setFeeTo`.
There is no pause, no blocklist, no per-pair override and no upgrade path, and
the router has no owner at all.

On the collection the owner can write the trait table (only until `seal`), seal
it (only with the table that matches the published `provenance`), point
`setRenderer` at an art contract — permanently surrendered by `freezeRenderer` —
and set the four launch parameters: the two prices, the per-transaction cap, the
per-wallet allowlist cap, plus the allowlist root and the one-way switch that
opens the public phase. That is the entire list. They cannot mint beyond the
222-piece reserve cap, cannot change the supply, mint deadline or Aave pool,
cannot redirect `withdraw` away from `treasury`, and cannot dive, surface, scar,
drown or transfer anybody's plate. Neither `UnderwaterTrophy` nor
`UnderwaterWaitlist` has an owner at all — the waitlist's registration window is
fixed in its constructor, so not even the deployer can extend it, close it early,
remove a registration, or add an address that did not register itself.

What none of that constrains is **who gets picked off the waitlist** — no contract
here bounds it, and none can. What bounds it instead is a published procedure:
[ALLOWLIST.md](ALLOWLIST.md), whose hash goes on chain before the waitlist contract
is deployed, and [`script/select.py`](script/select.py), which applies it. Every
input is public — registrations, an Aave debt balance at the waitlist's deploy
block, launchpad `Trade` logs, and a lottery seeded by the hash of the first Ink
block after the window closes. Same snapshot and same seed, same root.

Be precise about what that is worth. It is not enforcement: we could publish a root
that the procedure does not produce. It is *detection* — anyone can run three
commands and compare 32 bytes against the chain — plus a document that was
timestamped before anybody registered under it, so the rules cannot be quietly
rewritten to fit the outcome. That is the strongest guarantee available for a
decision no contract can make, and it is weaker than a contract. The document says
so itself, along with what it deliberately does not attempt.

Nor does any of it constrain **Aave.** The collection reads every plate's health
factor from one immutable pool address, and on Ink that pool is not run by us —
see the trade-off note below, because on mainnet it is not run by Aave governance
either.

The prices are the one deliberate concession, and it is worth being explicit
about what it costs. `price` and `wlPrice` target *dollar* figures — the
allowlist is meant to be $10 — and no fixed ETH amount holds a dollar figure
across a launch window. Three things bound it:

- **`PRICE_CEILING = 1 ether`,** enforced in the constructor and in both
  setters, so the range is fixed at deploy and the owner is held to the same
  bound the deploy was.
- **Payment must be exact.** `msg.value != unit * qty` reverts. A price raised
  under a pending mint makes that mint *fail*, not silently overcharge — there
  is a test that spends a wallet's balance to prove not a wei moves.
- **`maxPerTx` and `maxPerWallet` are bounded by `LIMIT_CEILING = 222`** and
  cannot be set to zero, so they cannot be used to halt a mint that is already
  open.

## Known risks and accepted trade-offs

These are deliberate decisions, not oversights.

**Router is mutable.** `setRouter` lets the owner redirect where future
graduations deposit liquidity — a real trust assumption, and the sharpest edge
in the contract. An immutable router would be a stronger guarantee, but a dead
or broken DEX would then permanently strand every funded curve. The failure
mode of mutability is bounded to *not-yet-graduated* launches; already-burned
LP is untouchable.

**Pair front-running.** Anyone can create the DEX pair before graduation and
seed it at a skewed ratio, so our deposit lands at their price. Liquidity is
therefore added with **zero slippage minimums** — non-zero minimums would
revert and strand the raise forever, which is far worse. Whatever the pool
declines is burned (tokens) or sent to the treasury (ETH), never left
recoverable in the launchpad. The attack costs the griefer real capital and is
exercised in
[`test_frontRunPairDoesNotStrandTheRaise`](test/fork/InkGraduation.t.sol)
against the live Ink DEX.

**Failed graduation parks the curve.** The liquidity deposit is wrapped in
`try/catch` so a reverting router cannot brick the final buy. On failure
nothing commits: the curve sits at the threshold, **selling still works** so
holders are never trapped, and anyone can retry `graduate()` once the router is
healthy. (An earlier draft had `graduate()` documented as a recovery hatch
while being unreachable — a reverting router took the whole buy down with it.
The `try/catch` is what makes the hatch real.)

**Sandwiching.** Curve trades are sandwichable like any AMM trade. Mitigated by
mandatory slippage bounds on `buy` and `sell`, not eliminated.

**Rounding dust.** A fully unwound curve retains a few wei, permanently
unreachable (`sweep` is bounded by `totalCurveEth`, which still counts it).
Harmless and on the safe side of the ledger.

**Running our own DEX costs distribution.** Two honest downsides, neither
technical:

- *Chart and aggregator visibility must be earned, not inherited.* Graduating
  into an established DEX means DexScreener, DeFiLlama and aggregator routing
  pick the pool up automatically. Our factory has to be submitted to each of
  them, and until it is, a graduated token has no chart anywhere. This is a
  listings/BD task, not a code change — but it is on the critical path for a
  launchpad, where "where's the chart" is the first question every buyer asks.
- *No external arbitrage or routing liquidity on day one.* An established V2
  deployment comes with bots already watching every pair and aggregators already
  routing through it, which keeps prices tight. Our pools start with none of
  that, so early spreads will be wider and cross-DEX prices will drift further
  before someone closes the gap. The V2-identical events and `uniswapV2Call`
  callback are what make existing bots cheap to point at us, but they still have
  to choose to.

Both are reasons the launchpad's `router` stays configurable: pointing
graduations at a third-party V2 router — or back at ours — is a single
`setRouter` call, and the two can coexist.

**The collection depends on an Aave instance nobody here controls — and on
mainnet, one Aave governance does not control either.** There is no canonical
Aave V3 deployment on Ink. What exists on mainnet is an Aave **whitelabel**: the
Aave V3 codebase, licensed and operated by a third party, listed in
`bgd-labs/aave-address-book` as `AaveV3InkWhitelabel`. Ink Sepolia has a testnet
instance with three reserves. Both are pinned in
[`script/InkAave.sol`](script/InkAave.sol) and re-checked against the live chains
by [InkAavePool.t.sol](test/fork/InkAavePool.t.sol).

This is a real dependency, and it is unusual enough to be worth stating plainly
rather than burying in a constant. Every plate's art is a function of a health
factor read from that pool. Whoever operates it sets the reserves, the risk
parameters and the oracles that decide what a health factor even means, and
`pool` is immutable, so a market wound down or misconfigured is not something a
setter can route around — plates would keep rendering, at whatever the pool says.
The mitigations are that the read is a single `getUserAccountData` call with no
approval, no deposit and no token flow of ours through Aave at all, so the worst
case is *bad data*, not lost funds; and that the same immutability which removes
the escape hatch is what stops us from pointing 2222 plates at a pool that lies.
An oracle you can swap is a lever over everybody's art. We would rather be stuck
with the one that was published.

It is also, for what it's worth, the honest version of the collection's premise:
a plate tracks a leveraged position on the chain it lives on, and that means
whatever lending market that chain actually has.

**Not audited.** 354 tests including fuzz runs and live-fork tests is not an
audit, and the DEX port raises the stakes rather than lowering them. Do not put
real money on this without one.

## Ink network details

Verified 2026-08-23 against `chainid.network` and by querying both RPCs
directly:

| | Mainnet | Sepolia testnet |
|---|---|---|
| Chain ID | 57073 | 763373 |
| RPC | `https://rpc-gel.inkonchain.com` | `https://rpc-gel-sepolia.inkonchain.com` |
| Explorer | `explorer.inkonchain.com` | `explorer-sepolia.inkonchain.com` |
| Gas token | ETH | ETH |

Both are preconfigured in [foundry.toml](foundry.toml) as `ink` and
`ink_sepolia`.

### Router

The launchpad's `DEX_ROUTER` can be **our own router** (deploy it with
[`script/DeployDex.s.sol`](script/DeployDex.s.sol)) or any Uniswap-V2-compatible
router already on the chain. On Ink Sepolia the first is the only option.

Both Ink networks expose the standard OP Stack WETH predeploy
`0x4200000000000000000000000000000000000006` — verified present with identical
bytecode on each, including the `deposit()` selector, so the same router
bytecode works on both.

**Third-party option, mainnet: `0xA8C1C38FF57428e5C3a34E0899Be5Cb385476507`**

Identified on-chain rather than from documentation. The explorer lists ten
verified `UniswapV2Router02` contracts on Ink; probing each for `factory()`,
`WETH()` and pair count found factory
`0x458C5d5B75ccBA22651D2C5b61cB1EA1e0b0f95D` with ~350 pairs (by far the
largest V2 deployment), served by two routers. Transaction counters settled it:
this one has 1,218,299 transactions, its sibling
`0x5D0cAfB2Bc6CAbD100472C8d72D8185a8EBe1889` has **zero** — same factory, so
it's an easy and costly mistake to make.

Note that it is confirmed canonical only by *behaviour* — pair count,
transaction count, and a passing live-fork lifecycle test. The explorer carries
no brand tags for it, so which DEX it belongs to is unidentified. That
uncertainty is itself part of the argument for running our own.

The choice is validated end-to-end by the fork tests below, not just by
counters.

**Third-party option, testnet: none exists.** No V2 router is deployed on Ink
Sepolia, which is why the launchpad could not run end-to-end there until the DEX
in this repo existed. Deploying our own factory + router is now the supported
path, exercised against the real Sepolia chain in
[InkOwnDex.t.sol](test/fork/InkOwnDex.t.sol).

Either way the deploy script refuses to run against an address that doesn't
answer `factory()` and `WETH()`, so a wrong router fails loudly at deploy time
instead of silently parking every graduation.

## Repo layout

```
src/
  UnderwaterLaunchpad.sol       factory + curve + fees + graduation
  lib/CurveMath.sol             pure curve math, rounds toward the pool
  token/MemeToken.sol           fixed-supply ERC20, no owner, no mint
  interfaces/IUniswapV2.sol     the two router/factory functions used
  utils/                        ERC20 (w/ permit), ERC721, Owned,
                                ReentrancyGuard, Base64, LibString, MerkleProof
  dex/                          our own V2-compatible DEX (GPL-3.0-or-later)
    UnderwaterFactory.sol       CREATE2 pair registry + fee switch
    UnderwaterPair.sol          reserves, swap maths, TWAP accumulators, LP
    UnderwaterRouter.sol        ownerless front door, full V2 surface
    libraries/                  UnderwaterLibrary, SafeTransferLib, Math, UQ112x112
    interfaces/IUnderwaterDex.sol
  nft/                          the 2222 plates — shares nothing but utils/
    UnderwaterPlates.sol        committed traits, Aave-driven state, drown/scar
    UnderwaterTrophy.sol        kill plate, fully on-chain art, one minter
    UnderwaterWaitlist.sol      allowlist intake: self-only, no owner, fixed window
    interfaces/IAavePool.sol    the single read: getUserAccountData
    interfaces/IUnderwaterRenderer.sol   the swappable art contract
    art/                        the renderer — five contracts, EIP-170 bound
      UnderwaterRenderer.sol    compose, dissolve defs, metadata, Base64
      UnderwaterFigures.sol     diver, headgear, held, tether     (generated)
      UnderwaterMarks.sol       relics, emblems, card chrome      (generated)
      UnderwaterScenes.sol      the five backdrops                (generated)
      UnderwaterNames.sol       trait labels + attributes JSON    (generated)
      UnderwaterDissolve.sol    health factor → filter parameters
      UnderwaterMath.sol        fixed-point roots, decimals, mulberry32
test/
  CurveMath.t.sol               curve invariants (fuzzed)
  Launchpad.t.sol               trading, fees, access control, reentrancy
  Graduation.t.sol              handoff, refunds, LP burn, recovery hatch
  dex/Pair.t.sol                mint/burn/swap, flash swaps, protocol fee
  dex/PairOracle.t.sol          the two wrapping sites, incl. the 2106 rollover
  dex/Factory.t.sol             registry, CREATE2 derivation, fee switch
  dex/Router.t.sol              slippage, deadlines, ETH legs, multi-hop, taxes
  dex/LaunchpadOnUnderwaterDex.t.sol   full launch → our own pool
  fork/InkGraduation.t.sol      end-to-end against the third-party Ink DEX
  fork/InkOwnDex.t.sol          our DEX on live Ink mainnet + Sepolia forks
  fork/InkAavePool.t.sol        the pinned Aave pool, incl. a real dive on both
  mocks/MockV2.sol              configurable V2 router for failure injection
  dex/mocks/DexMocks.sol        WETH9, taxed token, flash borrower, reenterer
  nft/Plates.t.sol              commit/seal, mint, allowlist, reveal, dive, drown
  nft/Trophy.t.sol              kill records + the decoded on-chain data URI
  nft/Waitlist.t.sol            the window, self-only registration, paging, packing
  nft/Dissolve.t.sol            the curve, the PRNG, the decimal formatting
  nft/Renderer.t.sol            whole plates, against the Python renderer
  nft/fixtures/RenderFixtures.sol   what render.py produced      (generated)
  nft/mocks/NftMocks.sol        Aave pool, renderer, receivers, reentrant minter
  utils/Encoding.t.sol          Base64 + LibString against fixed vectors
  utils/MerkleProof.t.sol       the allowlist verifier, vs. a Python-built tree
script/
  Deploy.s.sol                  launchpad
  DeployDex.s.sol               factory + router
  DeployPlates.s.sol            the collection, with an Aave pool sanity probe
  InkAave.sol                   the pinned Aave pool per chain id — not in src/
  DeployRenderer.s.sol          the five art contracts + setRenderer
  DeployWaitlist.s.sol          the intake contract; its window is final at deploy
  SealPlates.s.sol              commits the trait table and proves the art
  SetWhitelist.s.sol            sets the allowlist root, re-checking a proof first
  select.py                     applies ALLOWLIST.md to a waitlist snapshot
  whitelist.py                  builds the tree: root + one proof per address
  whitelist.txt                 the allowlist itself, one address per line
  waitlist-snapshot.txt         who registered on chain, from `npm run waitlist`
                                (gitignored — a working file for the selection)
web/                            Next.js 15 frontend (App Router, wagmi v2)
  app/page.tsx                  the market: every launch, depth-sorted
  app/create/page.tsx           launch a token, optional first buy in the same tx
  app/token/[address]/page.tsx  one launch: curve, sounding, trades, trade panel
  app/plates/page.tsx           the collection: story, on-chain art, provenance, CTAs
  app/mint/page.tsx             the checkout: phase, both prices, proof, mint panel
  app/waterdrop/page.tsx        allowlist registration: the window, the quest, register()
  components/TradePanel.tsx     buy/sell on the curve, contract-quoted fills
  components/PoolPanel.tsx      swaps after graduation, resolved from the launchpad
  components/TradeHistory.tsx   recent Trade events over a bounded block window
  components/MintPanel.tsx      the mint itself: allowlist proof or public, exact pay
  components/WaitlistPanel.tsx  register() for an allowlist spot, and what it isn't
  components/PlateArt.tsx       one plate, drawn by tokenURI at read time
  lib/hooks.ts                  batched reads: listings, detail, quotes, gas floor
  lib/plates.ts                 batched plates reads + the six-way phase, derived once
  lib/waitlist.ts               batched waitlist reads + the window, derived once
  lib/metadata.ts               unwraps data:application/json;base64 → the SVG
  lib/curve.ts                  the curve maths again, in TS, for local derivation
  public/whitelist.json         proofs from whitelist.py, served at /whitelist.json
  scripts/abis.mjs              generates lib/abis.ts from the Foundry build
  scripts/traits.mjs            generates the committed trait table + provenance
  scripts/waitlist.mjs          exports the registrations, reconciled against count()
  scripts/localchain.mjs        anvil + full deploy + seeded launches, no keys
traits/                         the published provenance artefact, from traits.mjs
  table.csv                     371 packed words — this is PLATES_TABLE
  traits.json                   the readable collection: names, indices, ranks
  provenance.txt                the hash the collection is deployed with
art/                            the art pipeline: assets as files, not as HTML
  extract.mjs                   lifts every drawn asset out of the prototype
  render.py                     composes any plate at any health factor
  solidify.py                   writes the four generated asset contracts
  fixtures.py                   writes the Solidity test fixtures
  keccak.py                     Ethereum keccak-256, since hashlib ships NIST's
  traits/                       44 drawn assets, one standalone SVG each
    manifest.json               anchors, transforms, palettes, dissolve constants
    diver/ headgear/ held/      the figure and what it wears and carries
    relic/ emblem/ scene/       the specimen card, the marks, the backdrops
    tether/ _frame/             the umbilical, and the card + stamp chrome
  showcase/                     contact sheets, from `render.py --showcase`
  out/                          preview renders, gitignored — 24 MB when full
underwater-prototype.html       the art's origin, kept as a browser preview toy
ALLOWLIST.md                    how the 500 allowlist spots are drawn, published
                                before registration opens and hashed on chain
```

No external Solidity dependencies beyond `forge-std` — `ERC20`,
`ReentrancyGuard`, `Owned` and the entire DEX are written in-repo, so nothing in
the trust path of every launched token comes from a submodule.

## Commands

Install (Foundry required):

```bash
forge install foundry-rs/forge-std
```

Build and test:

```bash
forge test
```

Heavier fuzzing (250k runs per property):

```bash
forge test --profile deep
```

Fork tests against live Ink — these skip automatically if the RPC is
unreachable, so the default suite stays green offline. The patterns match the
concrete per-chain contracts, which are named `Ink<Network><Thing>ForkTest`, so a
pattern has to be a substring of *that* and not of the abstract base:

```bash
forge test --match-contract OwnDex -vv
```

```bash
forge test --match-contract AavePool -vv
```

```bash
forge test --match-contract InkForkGraduationTest -vv
```

Gas report:

```bash
forge test --gas-report
```

Just the collection:

```bash
forge test --match-path "test/nft/*" -vv
```

Regenerate the collection's trait table and provenance hash:

```bash
cd web && npm run traits
```

### The art

Two steps, both idempotent, both file-in file-out. Extraction runs once and again
whenever the prototype's art changes; rendering runs whenever you want pictures.

Lift every drawn asset out of the prototype into `art/traits/**`:

```bash
node art/extract.mjs
```

Then compose plates from those files. Nothing is hardcoded — the renderer reads
`art/traits/manifest.json` for the geometry and `traits/traits.json` for the
sealed table, so both scripts above have to have run first:

```bash
python art/render.py --slot 5 --hf 1.45 --scars 2
```

The whole collection at one health factor — 2222 SVGs, ~24 MB, about a minute:

```bash
python art/render.py --all --hf 2.4
```

The committed contact sheets (one plate across every state, and one state across
six plates):

```bash
python art/render.py --showcase
```

The two states that are not a health factor — the pre-reveal survey tube every
plate passes through, and the post-liquidation burn:

```bash
python art/render.py --slot 5 --sealed
```

```bash
python art/render.py --slot 5 --drowned --scars 3
```

PNGs need one optional dependency; without it `--png` says so and still writes
the SVGs:

```bash
pip install cairosvg
```

### The renderer

Both halves of the Solidity port are generated from the same files
`render.py` reads, so neither can drift from the art without the other noticing.
Re-run both after any change under `art/traits/`:

```bash
python art/solidify.py && python art/fixtures.py && forge test --match-path "test/nft/*"
```

`solidify.py` writes the four asset contracts in `src/nft/art/`; `fixtures.py`
writes `test/nft/fixtures/RenderFixtures.sol` from the Python renderer's real
output. Both are committed — they are build output, but they are also the art, and
a deployment should not depend on a Python interpreter being present.

The art contracts compile under their own profile ([foundry.toml](foundry.toml)):
via-IR at 200 optimizer runs, restricted by path. They are `view`-only and
size-bound rather than gas-bound, which is the opposite trade from the DEX and
launchpad contracts that want all the inlining 1,000,000 runs can buy. The
restriction covers the whole directory rather than just the renderer, so that
every art contract has exactly one set of compiler settings — restrictions
propagate to imports, so naming only the renderer would compile the asset
contracts one way when reached through it and another when reached directly, and
"which bytes are on chain" is the one question this collection has to be able to
answer.

Expect the compile to be slow — via-IR takes 1–4 minutes on a cold cache for
these files, against seconds for the rest of the repo. The suite itself is ~45 s,
because it renders whole plates inside the EVM. Two fuzz tests carry per-test
`forge-config: default.fuzz.runs` comments overriding the project's 10,000: at
~6.5M gas per render the default cost 12 minutes for properties whose input space
is a handful of distinct cases, and the reasoning is at each one.

### The waitlist

Export everyone who registered on chain, into the snapshot the selection runs on:

```bash
cd web && npm run waitlist
```

Reads the address from `NEXT_PUBLIC_WAITLIST_ANVIL` in `web/.env.local` unless
given `--waitlist 0x…`, and defaults to a local node unless given `--rpc`. Every
read is pinned to one block number, so a registration landing mid-export cannot
produce a snapshot that is internally inconsistent, and the walk aborts rather
than truncating if the paged list disagrees with `count()`, repeats an address,
or contains an entry whose `standingOf` position isn't the index it came back
at. It deliberately does not filter — which registrants make the list is the step
below. Output is `script/waitlist-snapshot.txt`:

```
0x70997970c51812dc3a010c7d01b50e0d17dc79c8  # 1  2026-08-25 05:21 UTC
```

The header records the chain, the block, the count, and whether registration was
still open — a snapshot taken mid-window is not the final list and says so on its
own face.

Apply the criteria from [ALLOWLIST.md](ALLOWLIST.md) once the seed block exists
(the first Ink block whose timestamp is at or after `closesAt()`):

```bash
python script/select.py --seed 0x<blockhash>
```

Reads `script/waitlist-snapshot.txt` by default, ranks by qualified referrals,
prints the full workings — draw, score, rank — and writes `script/whitelist.txt`.
The non-selected are kept in the file as comments, so the published list carries its
own negative space. `--no-referrals` runs a pure lottery for a dry run.
`--self-test` checks every property the document claims.

When there are more than 2000 registrants, `select.py` needs a chain RPC to grade
each referred wallet's qualification:

```bash
python script/select.py --seed 0x<blockhash> --rpc https://rpc-gel.inkonchain.com \
  --pool <aave-pool> --launchpad <launchpad> --snapshot-block <S>
```

`--snapshot-block` is the waitlist's deploy block (block `S` in the document). It
defaults to the chain head, which is fine for a closed window but should be
supplied explicitly to reproduce a result exactly.

### The allowlist

The tree, from a list of addresses. No dependencies — it hashes with the same
vendored Keccak the art fixtures use:

```bash
python script/whitelist.py
```

Reads `script/whitelist.txt` (one address per line, `#` comments), prints the
root, and writes `web/public/whitelist.json` with one proof per address.
Duplicates are skipped rather than doubled, and checksum capitals are ignored,
because a leaf is `keccak256(keccak256(abi.encode(address)))` and that sees
bytes, not spelling.

`npm run localchain` overwrites that file with a five-member list over anvil's
own accounts, and says so when it does. Don't commit that version: the page
compares the file's root against the root on chain and would tell every visitor
the published allowlist doesn't match — correctly.

To regenerate the vector that [MerkleProof.t.sol](test/utils/MerkleProof.t.sol)
pins itself against:

```bash
python script/whitelist.py --solidity --addresses 0x…,0x…
```

### Frontend

The whole system, running locally, with no faucet and no keys. This starts anvil,
deploys the DEX and the launchpad to it, seeds five launches — one of which
crosses the threshold and graduates onto our own pool — then deploys the
collection: the real trait table committed and sealed, the five art contracts
wired up, a five-member allowlist over the anvil accounts at the launch limit of
2 per wallet, 229 plates minted across both phases, and two of them dived so one
is sinking and scarred and one is healthy. Last it deploys the waitlist with a
seven-day window already open and two accounts registered in it, so `/waterdrop`
has both the "register" and the "you are already on it" states to show. Every
address lands in `web/.env.local` and the proofs in `web/public/whitelist.json`:

```bash
cd web && npm install && npm run localchain
```

Then, in a second terminal:

```bash
cd web && npm run dev
```

`npm run dev` regenerates `lib/abis.ts` from `out/` first, so a stale ABI is not
a failure mode you can hit. If it complains that a contract has an ABI but no
bytecode, a previous `forge test` left sparse artifacts behind — `forge build
--force` fixes it.

Dev uses Turbopack, and currently has to: `npm run dev:webpack` fails to resolve
`@x402/evm/upto/client`, reached from `app/providers.tsx` through
`@wagmi/connectors` → `@base-org/account` → `@coinbase/cdp-sdk`. It is a subpath
the published package does not expose, so it is nothing in this repo to fix —
Turbopack simply never walks into that branch. `NEXT_PUBLIC_*` variables are
inlined at build time, so changing `.env.local` needs a dev-server restart.

### The plates pages

The collection has three routes reading two independent deploys.
[`/plates`](web/app/plates/page.tsx) is its home — the story, the on-chain art,
the provenance and the collection's shape — and it sends you to the two things
you can *do* rather than embedding either. [`/mint`](web/app/mint/page.tsx) is the
checkout: the phase, the two prices, the allowlist proof, and nothing else.
[`/waterdrop`](web/app/waterdrop/page.tsx) is allowlist registration. The first
two read the plates deploy; the waterdrop reads the waitlist — a chain can have
any subset of the three, so the masthead chip follows the route and says which one
it means.

Everything the owner can still change is read from the chain on an 8-second
poll, not baked into the bundle: both prices, both limits, and the allowlist
root. That is not caution, it is required — payment must be exact, so a page
holding a stale `wlPrice` sends a transaction that reverts with `WrongPayment`
and no explanation. The phase is derived in one place
([`phaseOf`](web/lib/plates.ts)) from `isSealed`, `merkleRoot`, `publicOpen` and
`mintCloses`, because the contract has no phase enum and six states spread across
the badge, the heading and the button is six chances for them to disagree.
`/plates` and `/mint` share that derivation and its copy table
([`PHASE_COPY`](web/lib/plates.ts)), so the showcase and the checkout cannot
describe the same phase two different ways.

The mint's allowlist half fetches `/whitelist.json` and looks the connected
address up in it. Before trusting a proof from that file it compares the file's
`root` against the root on chain: a published list from a previous tree still
verifies against itself, and the only symptom would be every member's mint
reverting. A mismatch says so instead.

**The waterdrop is its own funnel, not a panel bolted to the mint.** Registering
is a different act from buying — it opens and closes on its own window, against a
third deploy — so it gets its own route rather than sharing the mint control's
slot. The gate is the waitlist contract's own `isOpen`, not the page's clock, so a
window that has already ended cannot be talked into looking open by a wrong local
time; the countdown beside it is cosmetic, and starts at zero to be corrected in
an effect, like every other clock here. The reach it quotes — "around 2000 people"
— is the allocation divided by the per-wallet limit, and the limit half of that
division is read from the plates contract on the same poll as everything else,
because it is settable and a hardcoded reach figure would quietly become a lie the
moment it changed. The allocation is bundled, since `WL_ALLOCATION` is a Solidity
constant and nobody can move it. What [`WaitlistPanel`](web/components/WaitlistPanel.tsx)
refuses to do is overpromise: two of its steps are honour-system and it says so,
the arrival number it returns is a receipt and not a rank, and the referral tally is
shown as the rank the criteria make it — with the caveat the raw count cannot show,
that only qualified referrals count.

The art on `/plates` is not a preview. `PlateArt` calls `tokenURI`, unwraps the
base64 JSON and then the base64 SVG inside it, and shows what the contract drew
during that call. Before the reveal `traitsOf` reverts by design, so every plate
renders the same blank card and the page shows one, captioned — three identical
placeholders would read as art that does not vary.

## Deploying

The DEX goes first, because the launchpad needs a router address. Dry runs print
the resolved config and validate the wiring without broadcasting.

1. Deploy factory + router:

```bash
forge script script/DeployDex.s.sol --rpc-url ink_sepolia
```

It prints the router address and the pair init code hash. Set `DEX_ROUTER` in
`.env` to that router. (Skip this step entirely if you're pointing at a
third-party V2 router instead.)

2. Deploy the launchpad:

```bash
forge script script/Deploy.s.sol --rpc-url ink_sepolia
```

Add `--broadcast --verify` to either once the dry run looks right (Ink runs
Blockscout, no API key needed):

```bash
forge script script/Deploy.s.sol --rpc-url ink --broadcast --verify --verifier blockscout --verifier-url https://explorer.inkonchain.com/api
```

Copy `.env.example` to `.env` first. For mainnet, prefer `--ledger` over a
`PRIVATE_KEY` in a file.

The DEX protocol fee deploys **off**. Enable it later with
`UnderwaterFactory.setFeeTo(<treasury>)`, ideally once the owner is a multisig.

### Deploying the collection

Independent of the launchpad — it needs no router and no DEX.

1. Generate the trait table and the provenance hash. Rejection-sampled for
   uniqueness, packed into 371 words, and verified by unpacking it again rather
   than by agreeing with the packer:

```bash
cd web && npm run traits
```

   It is deterministic — same table, same hash, every run and every machine — so
   anyone can re-run it and check the hash we published instead of trusting it.
   The provenance must be published **before** the deploy; a hash chosen
   afterwards commits to nothing. Verify it independently against Solidity's own
   ABI coder, which is what `seal()` uses:

```bash
cast abi-encode "f(uint256[])" "[$(cat traits/table.csv)]" | cast keccak
```

2. Deploy. The pool address is resolved from the chain id
   ([`script/InkAave.sol`](script/InkAave.sol)) rather than read from `.env`,
   because `aavePool` is immutable and an env var that has to be right by hand on
   the one deploy that cannot be undone is the wrong shape for it. The script still
   refuses to run unless that pool answers like an Aave V3 pool — reports
   `type(uint256).max` for an address with no debt, and lists at least one reserve —
   since a wrong or wound-down pool bricks every plate's state permanently:

```bash
PLATES_RESERVE=0 PLATES_MAX_PER_WALLET=1 forge script script/DeployPlates.s.sol --rpc-url ink_sepolia
```

   `PLATES_MAX_PER_WALLET` is optional and only tightens the allowlist depth the
   collection is *born* with; step 7 sets it authoritatively either way. It is
   worth passing here because `/waterdrop` shows this number to everyone
   registering, and the constructor's 22 advertises an allowlist that reaches 90
   people. `PLATES_RESERVE=0` is not optional at a real deploy: 2000 allowlist
   plates plus the default 222 reserve is the entire 2222 supply, leaving nothing
   for the public phase, so ALLOWLIST.md commits to a zero reserve.

3. Publish the selection criteria's hash, **before** the waitlist exists.
   [ALLOWLIST.md](ALLOWLIST.md) claims it was fixed before anybody registered
   under it, and a git commit date cannot prove that — whoever commits sets it.
   The hash in a block earlier than the waitlist's deploy can:

```bash
cast keccak "$(cat ALLOWLIST.md)"
```

```bash
cast send --value 0 --private-key $PRIVATE_KEY $(cast wallet address --private-key $PRIVATE_KEY) \
  --rpc-url ink_sepolia 0x<that-hash>
```

   A zero-value self-send carrying the hash as calldata — the cheapest durable
   timestamp there is. Publish the transaction hash with the waitlist address, and
   do not edit the document afterwards: an amendment is a new hash in a new
   transaction, and only before registration opens. This is the one step in this
   list that cannot be done late.

4. Deploy the waitlist. Independent of everything above — it takes no addresses
   and holds no reference to the collection — but do it after step 2 so `/waterdrop`
   has a collection to read the allocation and per-wallet numbers from:

```bash
WAITLIST_WINDOW=$((7 * 86400)) forge script script/DeployWaitlist.s.sol --rpc-url ink_sepolia
```

   The window is set in the constructor and there is no setter, so the dry run is
   the only chance to check it: the script prints the open and close timestamps,
   how many hours that is, and whether registration begins immediately. Defaults
   are "now" and seven days; `WAITLIST_OPENS` and `WAITLIST_CLOSES` override
   either end. Leaving `WAITLIST_OPENS` blank is worth doing on purpose — the
   criteria measure the priority tiers at the deploy block, so opening in that same
   block closes the gap in which anything could be arranged against known rules.
   Put the address in `NEXT_PUBLIC_WAITLIST_<CHAIN>` and the panel appears on
   `/waterdrop`.

5. Deploy the art and wire it up. Five contracts — the four asset ones, then the
   renderer with their addresses — plus the `setRenderer` call, in one script. Do
   this **before** step 6: `tokenURI` resolves to nothing until the renderer is
   set, and minting should not open on a collection that renders blank.

```bash
PLATES=0x… forge script script/DeployRenderer.s.sol --rpc-url ink_sepolia
```

   It probes `PLATES` before spending anything — supply, trophy, and that the
   renderer is not already frozen — because a typo would otherwise deploy five
   contracts and revert on the wire-up, leaving the art on chain but unreferenced.
   It wires up only if the broadcaster is the owner, and prints the `cast send` to
   run if not, so a multisig-owned collection is the same script plus one manual
   call. It also re-checks all five sizes against EIP-170 from `code.length` on
   chain — the same assertion the tests make, but against what actually landed.

6. Commit the table and prove the art. The script hashes the table locally and
   refuses to send anything if it does not match the on-chain provenance, so a
   wrong file costs nothing instead of six wasted commit transactions:

```bash
PLATES=0x… PLATES_TABLE=$(cat traits/table.csv) forge script script/SealPlates.s.sol --rpc-url ink_sepolia
```

   The seal opens neither phase. It is the gate both phases sit behind.

7. Draw the allowlist, once registration has closed. Three commands, and the
   result is reproducible by anyone who runs the same three — export the intake,
   apply the published criteria, build the tree:

```bash
cd web && npm run waitlist -- --rpc https://rpc-gel.inkonchain.com --waitlist 0x…
```

```bash
python script/select.py --seed 0x<first-block-hash-after-closesAt> \
  --rpc https://rpc-gel.inkonchain.com --launchpad 0x… --snapshot-block <deploy-block>
```

```bash
python script/whitelist.py script/whitelist.txt
```

   The seed is the hash of the first Ink block whose timestamp is at or after the
   waitlist's `closesAt()` — it does not exist while the window is open, which is
   the point. `select.py` prints every registrant's draw, score and rank, and needs
   the RPC arguments only when more than 2000 registered; below that, rule 1 takes
   everybody and it says so without reading the chain at all.

   `whitelist.py` then prints the root and writes `web/public/whitelist.json` — one
   proof per address, served at `/whitelist.json` for the mint page to hand each
   visitor their own. Every proof is re-verified before anything is written, because
   a tree that fails to verify would otherwise be discovered as an allowlist nobody
   can mint against.

   Publish the snapshot, the seed and the tree together. Without all three the
   selection is not checkable, and "checkable" is the entire claim.

8. Open the allowlist. `WL_MEMBER` and `WL_PROOF` are one entry from that JSON;
   the script verifies them against the new root using the same library the
   contract uses, before broadcasting. A wrong root is a silent failure — the
   transaction succeeds and then nobody on the list can mint — so this check is
   the point of having a script at all:

```bash
PLATES=0x… WL_ROOT=0x… WL_MEMBER=0x… WL_PROOF=0x…,0x… WL_MAX_PER_WALLET=1 \
  forge script script/SetWhitelist.s.sol --rpc-url ink_sepolia --broadcast
```

   `WL_MAX_PER_WALLET` goes out in the same broadcast, and deliberately in the
   transaction *before* the root: for the few seconds between them the allowlist
   is live, and the tighter limit being briefly in force is harmless where the
   looser one is not. Omit it to leave the limit alone — which is what a second
   wave that only replaces the root wants.

9. Open the public phase when the allowlist has run its course. One-way, and
   there is no matching close:

```bash
cast send <plates> 'openPublicMint()' --rpc-url ink_sepolia
```

   Prices are settable throughout, bounded at 1 ETH, and payment must be exact —
   so re-pegging `wlPrice` to hold $10 as ETH moves cannot overcharge a pending
   mint, only make it revert:

```bash
cast send <plates> 'setWhitelistPrice(uint256)' $(cast to-wei 0.00333) --rpc-url ink_sepolia
```

`reveal` is then permissionless, and callable only once minting can no longer
change the outcome — sold out, or past the window.

## Test coverage

354 tests, all passing, 0 skipped.

**Launchpad and curve**

- **Curve invariants (fuzzed, 10k runs each):** splitting buys never beats one
  buy; round trips never profit; `k` never decreases on buy or sell;
  `ethInForTokens` is a sound inverse of `tokensOut`.
- **Accounting:** quotes match execution exactly (fill, fee, and refund);
  curves fully unwind; the launchpad is never short of `totalCurveEth` across
  fuzzed interleaved trades.
- **Adversarial:** reentrancy via a malicious fee recipient; sweep bounded away
  from curve funds; fee ceilings; two-step ownership; ETH-rejecting recipients.
- **Graduation:** exact threshold trigger, final-buy size-down and refund, LP
  burned to `0x…dEaD`, unsold tokens burned, curve closed afterwards, skewed
  pair leaves nothing stranded, reverting router parks the curve and retry
  succeeds.
- **Graduation gas floor:** the buy refuses a budget too small to seed the pool;
  ordinary buys are unaffected; the reserve is bounded above the real cost and
  below a wasteful one; and, swept across gas limits on both the mock and the
  real router, every limit at which the final buy succeeds is one at which the
  token graduated and the pool exists.

**DEX**

- **Oracle / porting risk:** accumulators advance by price × elapsed seconds and
  weight the *pre-update* price; nothing accrues within one second or before
  liquidity exists; the oracle survives a warp past the 2106 uint32 rollover and
  still counts 60 seconds as 60; a deliberately overflowed accumulator still
  yields the correct snapshot difference (also fuzzed from arbitrary starting
  points).
- **Pair:** first mint is the geometric mean minus the locked
  `MINIMUM_LIQUIDITY`; off-ratio deposits credit only the scarcer side; one-sided
  donations mint nothing; `k` is enforced to the wei (the quote `+ 1` reverts);
  paying output to a pool token is rejected; flash swaps succeed when repaid with
  the fee and revert when not; reentrancy through the callback reverts;
  `skim`/`sync`; the uint112 reserve ceiling; and all four protocol-fee states
  including "cannot be charged retroactively".
- **Factory:** registry symmetric in both orderings, tokens stored sorted,
  duplicate/identical/zero rejected, creation permissionless, `initialize` is
  factory-only and one-shot, and the published `pairInitCodeHash()` provably
  derives the real pair address (fuzzed for uniqueness).
- **Router:** creates pools on demand, refunds the dust the pool ratio rejects,
  scales the surplus side down, enforces slippage in both directions and
  deadlines, `removeLiquidity` with and without permit (real `vm.sign`
  signature), all six swap variants, multi-hop through WETH with nothing left
  parked mid-route, invalid paths and missing pools, a 1%-tax token that requires
  the fee-on-transfer variant, stray ETH rejected, and the router holding zero of
  everything afterwards. Fuzzed: quotes always match execution; exact-output
  always costs at least the quoted input.
- **System:** a full launch graduating onto our own DEX — pool seeded with
  exactly 3.8 ETH + 200M tokens, launchpad fully drained (ETH, tokens, and its
  router approval reset), unsold supply burned, LP burned, no reachable account
  able to pull the liquidity, a stranger buying and selling afterwards, listing
  price above the average curve price, pool price matching the deposited ratio,
  and a pre-created skewed pool still not stranding the raise.

**Underwater — the collection**

- **Provenance:** `seal` rejects a table with a **single nibble** flipped, and
  rejects an empty one; minting cannot open before the seal; the table cannot be
  rewritten after it. Every one of the 2222 committed trait sets is reachable and
  no slot is used twice — the reveal offset is checked to be a real shift, not
  the identity map, so the test cannot silently stop exercising the wraparound.
- **Mint:** ids issued sequentially after the treasury reserve; exact payment
  enforced in both directions; qty 0 and over the per-tx cap rejected; the
  deadline is inclusive on its own second and shut one second later; a contract
  that does not implement `onERC721Received` is refused; a receiver that
  **re-enters `mint` from the callback** is blocked by the transient-storage
  guard with nothing minted; a full 2200-piece sell-out then reverts `SoldOut`;
  `withdraw` is permissionless and lands at `treasury`.
- **Allowlist:** every member of the tree proves, including the one promoted up
  two odd layers whose proof is shorter than the depth; a non-member is refused
  with an empty proof and with a member's proof, and a valid proof is refused for
  a *different* member, since the leaf is the sender's; an unconfigured root is
  `NoWhitelist` rather than a tree everyone is in; the phase cap is exercised to
  exactly 2000 and one past it; the per-wallet cap binds across transactions but
  not across addresses; the allowlist price is charged, not the public one; both
  the seal and the deadline still gate it; replacing the root blocks further mints
  without clawing back what was claimed; and a full sell-out proves the 1999 unused
  allowlist plates stay mintable in the public phase.
- **Mutable launch parameters:** every setter is owner-only and bounded — prices
  at `PRICE_CEILING` and limits at `LIMIT_CEILING`, both accepted *at* the
  ceiling and refused one past it, in the constructor as well as the setters;
  limits cannot be zeroed; zero price mints free, which is deliberate;
  `openPublicMint` is one-way and idempotent; `setMaxPerTx` binds both phases and
  `setMaxPerWallet` only the allowlist, and lowering it below what an address
  already took blocks further mints without unminting any. **A price raised under
  a pending mint reverts rather than overcharging** — asserted on the buyer's
  balance, not just the revert.
- **The allowlist verifier** ([MerkleProof.t.sol](test/utils/MerkleProof.t.sol)):
  pinned against a seven-member tree built by `script/whitelist.py` in Python, so
  the two implementations agree on a root rather than each agreeing with itself.
  Then: every member proves in trees of every size from 1 to 64 (the shapes are
  what matter — powers of two, one past them, and the long runs of odd layers
  between — so they are enumerated, not sampled); tampered, reordered, truncated
  and padded proofs all fail; a proof does not carry to another tree; a single-leaf
  tree is its own root; and an internal node verifies *as* a leaf, which is the
  test that records why leaves are hashed twice.
- **The waitlist** ([Waitlist.t.sol](test/nft/Waitlist.t.sol)): a window that
  cannot accept anybody is rejected in the constructor rather than deployed;
  both edges of the window are inclusive, asserted at the exact second; an
  unregistered address reads as zero instead of reverting; an address cannot
  register twice; a contract account can register itself, since a smart wallet is
  a normal user here; and four second-party selectors the contract does *not*
  have are called raw, to pin down that nobody can be registered by somebody
  else. Paging clamps a tail shorter than the limit and reverts on a start past
  the end, so an exporter cannot mistake a short page for the end of the list —
  and fuzzed over member counts and page sizes, the pages a snapshot walk
  collects reassemble into exactly what `all()` returns, which is the property the
  exporter depends on. Position and timestamp share one storage slot: they
  round-trip fuzzed across the window and behind up to 30 earlier registrants, and
  are read back at a timestamp of 4e9 to prove the halves do not bleed into each
  other. And it cannot take custody of anything: a plain 1-ether send to it fails
  and the balance stays zero, because there is no payable entry point for value to
  land in. **Referrals are recorded, never rewarded:** a referral credits the
  referrer and changes nothing about anyone's standing — the list the tree is
  built from stays arrival order — a referrer must already be registered, a
  self-referral reverts, a mangled `address(0)` still registers the holder, credit
  does not propagate up a chain, and the one-per-address rule caps a referral count
  at the number of real addresses that joined. The window is checked before the
  referrer, so a closed window reports itself rather than blaming the link.
- **Reveal:** reverts while minting can still change the outcome, and is
  permissionless once it cannot. Traits read back byte-for-byte from the
  committed table, checked at both id and category bounds.
- **Aave-driven state:** `dive` binds `msg.sender` and refuses on anyone else's
  behalf; a transfer auto-surfaces so a seller cannot drown art they no longer
  own; scars require HF strictly below the threshold, land immediately on the
  first call (a real regression — an epoch-based rate limit swallowed it), are
  rate-limited after that, cap out, and survive both surfacing and a sale;
  `drown` needs HF ≤ 1e18 exactly, burns the plate, mints the hunter an engraved
  trophy, and cannot be run twice.
- **Metadata:** `tokenURI` reflects live position state; royalty resolves to 5%
  of any sale price to `treasury`; `supportsInterface` answers for 721, metadata
  and 2981 and **denies** enumerable. The trophy's data URI is base64-**decoded**
  in the test and asserted field by field — name, block, plate and hunter
  attributes — then the nested SVG is decoded again and checked for a well-formed
  root and the engraved plate number, health factor and block.
- **Encoding:** `Base64` against the RFC 4648 vectors plus the 32/33/34/35-byte
  lengths that straddle the memory word boundary, where the encoder's two-byte
  overread lives; the surrounding memory is asserted intact afterwards, since the
  scrub writes into an allocation it does not own. `toFixed` is asserted to
  truncate, not round — a health factor printed as `1.000` when it is really
  `0.9999` would read as solvent on a plate that can be drowned.
- **Renderer arithmetic** ([Dissolve.t.sol](test/nft/Dissolve.t.sol)): every
  number the picture depends on, against `art/render.py`'s real output. `sqrt` is
  the floor root and exact on exact squares (fuzzed); `nearest` is within a half
  and breaks ties upward (fuzzed) — the two properties that make "round once, at
  print time" safe. `t^1.75` is pinned at both endpoints, stays under the
  identity and is monotone. `progress` clamps at both ends and never improves as
  health falls. Then the differential rows: 16 health factors — both ends, every
  band boundary, both exact ties the float prototype got wrong — reproducing all
  nine filter parameters as *strings*; 24 mulberry32 draws off the showcase
  plate's seed; 8 seed derivations including the u32 multiply wraparound; and one
  draw per coordinate shape at 0, 1, 2 and 4 decimal places, signed and not,
  including the negative-zero case where the sign must survive rounding to
  `-0.00`.
- **Whole plates** ([Renderer.t.sol](test/nft/Renderer.t.sol)): the real renderer
  deployed, and `render` called exactly as `tokenURI` calls it. 17 rows, one per
  branch it can take — sealed, dry dock, the dissolve ceiling, each depth band,
  drowned, each of the four substrates, gold leaf on blueprint (the one pigment
  that does not invert), each fauna branch, and the two blanks that must consume
  no PRNG — each pinned by `keccak256` of the token URI Python produced. The two
  hand-transcribed states compared as whole strings. Plus the properties fixtures
  cannot state: a sealed plate is byte-identical whatever traits, health factor
  and scars it is handed (fuzzed — this is the renderer's half of the fairness
  claim, since `tokenURI` passes the real values through even while unrevealed)
  yet still differs by plate number; scars past the cap clamp rather than revert
  (fuzzed); liquidation is inclusive at exactly 1e18 and one wei above it is not;
  all 62 trait options render; an undefined nibble reverts; and the output really
  is `data:application/json;base64,` followed by nothing outside base64's
  alphabet.
- **Size:** every deployed contract is asserted under the EIP-170 limit in the
  suite itself, rather than trusting a build-time report — the plates, the trophy,
  the waitlist, the renderer and its four asset contracts. The renderer is the
  tight one at 17,871 B of 24,576. (`UnderwaterDissolve` and `UnderwaterMath` are
  libraries, inlined into their callers rather than deployed.)

**Live fork (both networks)**

- Full lifecycle on Ink mainnet against the third-party DEX: real pair created
  with 3.8 ETH of liquidity, LP burned, launchpad fully drained, and a third
  party successfully swapping ETH → token on it afterward.
- Our DEX deployed onto forks of **both Ink mainnet and Ink Sepolia** against
  each chain's real WETH predeploy, running a full launch plus a native-ETH round
  trip — which exercises the actual `deposit()`/`withdraw()` legs a mock WETH
  never would.
- The Aave pool the collection is deployed against, on both chains, against the
  live markets ([InkAavePool.t.sol](test/fork/InkAavePool.t.sol)). The address is
  immutable on the collection, so it is pinned as a constant rather than carried
  in a `.env`, and this is what says the constant is still true: the resolver
  agrees with the chain, there is code at the address, it passes the deploy
  script's probe, it reports a non-zero `POOL_REVISION` and an addresses provider,
  and it still lists reserves — the last of which is how a market that has been
  *wound down* gets noticed, since delisting everything would leave a pool
  answering every other check correctly while being useless to a plate. Then the
  whole thing end to end: a real collection constructed against the real pool,
  sealed, a plate minted and `dive`d, and its health factor read back *through the
  collection*.

## Not built yet

- **The allowlist itself.** The machinery is built and tested, so is the intake
  that feeds it, and so are the criteria that turn one into the other
  ([ALLOWLIST.md](ALLOWLIST.md), applied by
  [`script/select.py`](script/select.py)) — but the *list* is empty. Nobody has
  registered, because nothing is deployed.
  [`script/whitelist.txt`](script/whitelist.txt) still holds the template.
- **The criteria's on-chain timestamp.** ALLOWLIST.md's whole claim is that it was
  fixed before anyone registered under it, and the thing that proves that is its
  `keccak256` posted on chain in a block earlier than the waitlist's deploy. That
  transaction has not been sent, for the same reason the list is empty. It is the
  one step in the runbook that cannot be done late.
- **A live deploy.** Every contract is written and tested, and the scripts run
  clean as dry runs, but nothing is on a real network — not even Sepolia. The
  renderer in particular has never had a plate pulled from it by a marketplace,
  which is the thing `freezeRenderer` exists to wait for.

- Wallet coverage beyond injected. WalletConnect and a Coinbase connector both
  want project IDs, so the app ships injected-only rather than showing buttons
  that fail.
- Indexer — the `Trade` event deliberately carries both reserves and the raise
  so an indexer can derive price, market cap and curve progress from logs alone
  with no follow-up RPC call per trade. Post-graduation it can switch to the
  standard V2 `Swap` / `Sync` / `PairCreated` events our DEX emits, so one
  indexer covers both halves of a token's life. Until then the frontend reads
  `Trade` logs directly over a bounded block window and says which window it
  actually got, rather than presenting a partial list as full history.
- Aggregator and charting submissions for our factory (DexScreener, DeFiLlama,
  routing aggregators) — see the trade-off note above; this is what turns a
  working pool into a visible one
- Creator/social metadata beyond a single `metadataURI` string
- An audit
