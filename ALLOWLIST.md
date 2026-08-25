# Allowlist selection criteria

**This is the document `/mint` refers to.** The waitlist panel tells everybody who
registers that the allowlist is "a Merkle tree built from this list under criteria
published before registration opened," and that "arrival order is a receipt, not a
rank." This is those criteria. It is published before registration opens, its hash
is posted on chain before the waitlist contract exists, and every rule in it is a
function of public data — so the finished list is not something you have to take our
word for. You can rebuild it.

It says what it says and nothing more. Registering does not reserve a plate.

## The number

**500 addresses.** `WL_ALLOCATION` reserves 1000 of the 2222 plates for the
allowlist phase, and `maxPerWallet` is set to **2** before the root goes up. 1000 ÷
2 = 500. Both numbers are on chain and the mint page reads the second one directly
off the collection, so if this figure is ever wrong, the page will disagree with it.

The 2 is the whole reason a selection exists at all. The constructor's ceiling is
22, at which the same 1000 plates fit inside 46 addresses. 2 spreads them across
roughly 500 people instead, which is worth having and is also what creates the
problem this document solves: 500 spots is a number that can run out.

## Rule 1 — if 500 or fewer register, everybody is on it

No selection, no lottery, no tiers. Every address that registered goes into the
tree.

**This is the expected outcome and it is stated first on purpose.** A document that
opened with an elaborate ranking procedure would imply a contest that probably will
not happen, and implying scarcity that does not exist is its own kind of
dishonesty. Everything below is contingency. It is written out in full anyway,
because criteria that only exist once they are needed are not criteria.

## Rule 2 — if more than 500 register

Then there is a procedure, and it is entirely mechanical. Three inputs, none of
them ours to choose:

**The snapshot block, `S`** — the block in which `UnderwaterWaitlist` was deployed.
Every qualification below is measured *at that block*. Registration cannot open
before the contract exists, so `S` is at or before the first possible
registration: nothing that counts toward a tier can be manufactured after these
rules are known. Deploying with `WAITLIST_OPENS` blank makes registration open in
`S` itself and closes the gap entirely, which is why the runbook recommends it.

**The seed block, `B`** — the first Ink block whose timestamp is at or after the
waitlist's `closesAt()`. The **seed** is that block's hash.

`B` does not exist while registration is open, so nobody can register strategically
against it, and we cannot pick it: we do not sequence Ink. What we can do is name
the rule in advance and publish the value we got, which is this paragraph. The
honest limit is that Ink's sequencer *could* in principle influence a block hash;
it has no stake in who gets a discounted plate, and this is the strongest seed
available without asking every registrant to also submit a commitment, which would
turn a one-transaction intake into a two-transaction one and lose more people than
it protects.

**The draw** — for each registered address `a`:

```
draw(a) = uint256(keccak256(abi.encode(seed, a)))
```

64 bytes: the 32-byte seed, then the address left-padded to 32 bytes. The same
`abi.encode` convention as the Merkle leaves in
[`src/utils/MerkleProof.sol`](src/utils/MerkleProof.sol), so there is one encoding
rule to get right in this repo rather than two. **Lower draws win.** Ties break on
the address ascending — draws are 256 bits and a tie will not happen, but an order
that is not total is not a procedure.

Each address has exactly one draw and keeps it through every round below. One
number per address explains the entire result.

### The rounds

**Round 1 — Divers, up to 350.** Registrants whose Aave position at block `S`
carried debt: `getUserAccountData(a).totalDebtBase > 0` on the pool this collection
reads, pinned in [`script/InkAave.sol`](script/InkAave.sol). Taken in draw order.

Debt, not collateral, and that is the point of the tier rather than a detail of it.
A plate renders a **health factor**. An address with collateral and no debt reads
`type(uint256).max` — the same value as dry dock — and its plate would sit crisp at
the surface forever, which is the one state the art has nothing to say about. A
depositor is not underwater. A leveraged position is the subject of the collection,
and someone who already holds one will watch their plate move for reasons that have
nothing to do with us.

**Round 2 — Crew, filling whatever is left of the 350.** Registrants who had at
least one `Trade` event from [`UnderwaterLaunchpad`](src/UnderwaterLaunchpad.sol)
with `trader == a` in a block at or before `S`. Taken in draw order.

Second rather than first because the launchpad and the collection share this repo
and almost nothing else — no contract, no token, no fee path. Trading on one has
never been a claim on the other, and it should rank below the thing the art is
actually made of.

**Round 3 — everyone else, filling the list to 500.** Every registrant not already
selected, *including* the ones rounds 1 and 2 did not reach. Taken in draw order.

Two consequences worth stating plainly, because they are the reason the rounds are
shaped this way:

- **Qualifying can never hurt you.** A Diver who misses the 350 falls straight back
  into round 3 alongside everybody else, carrying the same draw. There is no
  arrangement of registrants in which being in an earlier tier leaves you worse off
  than being in none — `script/select.py --self-test` checks exactly that, over
  hundreds of randomised tier splits.

  Worth being precise about how much that fallback is worth, though, because the
  reused draw cuts both ways. An address that missed round 1 did so by drawing worse
  than 350 of its peers, and it carries that same number into round 3 — so unless
  Divers make up most of the list, a missed Diver is unlikely to win the open round
  either. Reusing the draw is what makes the tiers safe to enter; it does not make
  the fallback a second chance. It is one lottery with three chances to be read
  from, not three lotteries.
- **At least 150 spots are always decided by nothing but the draw** whenever rounds
  1 and 2 could fill the 350. If you have never touched Aave or this launchpad, you
  are not making up the remainder — you are in a lottery for 30% of the list, and
  quite possibly for all of it, since unused priority spots roll into round 3
  automatically. This mirrors what the contract already does with the phase itself:
  allowlist plates the allowlist does not use roll into the public mint.

Rule 1 is just this procedure with fewer than 500 registrants — every round ends
with the list not yet full, so everyone is taken. There is one procedure, not two.

## What these criteria deliberately do not do

**They do not filter sybils, and no wording here pretends otherwise.** Nothing in
public chain data distinguishes 200 addresses held by one person from 200 people.
We could invent a heuristic; a heuristic applied by us, off chain, to decide who is
real is discretion wearing a procedure's clothes, and removing discretion is the
entire point of this document. So the position is: an allowlist spot is worth the
gap between $10 and the public price, times 2, and that is what a sybil farm is
buying with 500 registrations, 500 lots of gas, and — for the priority rounds — 500
funded leveraged positions opened before block `S`. It is bounded, it is not zero,
and pretending it is zero would be worse than saying so.

**They do not weigh anything off chain.** No Discord role, no follower count, no
form, no application, no email. Not because those are worthless signals but because
none of them can be checked by the person they are being applied to.

**They do not rank by arrival order.** Registration position is recorded on chain
and appears in every snapshot, and it is a receipt: proof you registered and when.
It is not an input to any round above. First-come-first-served rewards whoever
happened to be awake, and a 7-day window that is really a 90-second window is a
worse deal than a lottery honestly described as one.

**They do not check whether an address can hold a plate.** The collection mints
with `_safeMint`, so a contract that does not implement `onERC721Received` cannot
receive one. Register the address you actually want on the list. A spot in the tree
is not transferable to another address and there is no appeal for one that turns out
not to work — a Merkle root cannot be edited, only replaced wholesale.

## Not selected

The public phase. It is at least 1000 plates and however many the allowlist did not
use, at `price` rather than `wlPrice`, and it opens after the allowlist —
[`openPublicMint`](src/nft/UnderwaterPlates.sol) is one-way, and the allowlist stays
open once it fires, so being in the tree is a right to the discounted price, never a
deadline.

If a second wave is ever run, it is a new root over a new list under criteria
published the same way, and this document does not promise one.

## Rebuilding the result

Three artifacts get published when the list does: the snapshot, the seed, and the
tree. With them and this document, the selection is reproducible by anyone,
including someone who thinks we cheated.

```bash
npm run waitlist -- --waitlist <address> --rpc <ink-rpc>
```

The complete intake, straight off the contract, pinned to one block —
`script/waitlist-snapshot.txt`. It does not filter, so it is checkable against the
chain on its own.

```bash
python script/select.py --snapshot script/waitlist-snapshot.txt --seed 0x<blockhash>
```

The procedure above, applied. It prints every registrant's draw, tier and round, so
a disagreement about the result lands on a specific line rather than on the whole
list, and it writes `script/whitelist.txt`.

```bash
python script/whitelist.py script/whitelist.txt
```

The tree and every proof, into `web/public/whitelist.json` — the file the mint page
serves. It re-verifies each proof the way the contract will before writing
anything.

Then the root goes up with `script/SetWhitelist.s.sol`, which re-checks one member's
proof against the root before broadcasting it.

**Every step is deterministic given the seed.** Same snapshot and same seed, same
root — which means the check that matters is not reading our output but running the
three commands and comparing 32 bytes against what is on chain.

## Publication

This file's `keccak256` is posted on chain in a zero-value transaction from the
deployer before `UnderwaterWaitlist` is deployed, so the hash's block number is
lower than `S` and lower than any registration. The transaction and the hash go in
the announcement alongside the waitlist address. Hash the file yourself:

```bash
cast keccak "$(cat ALLOWLIST.md)"
```

Git commit dates are set by whoever commits, so the repo alone cannot prove this
document predates the window. The on-chain hash can, and that is the only reason it
exists.

**Amendments before registration opens** are republished the same way: a new hash,
a new transaction, both before `S`, with the change described. **After registration
opens, this document is final.** Not because it is perfect — because the promise on
the page is that the rules were fixed before anyone registered under them, and a
rule changed afterward makes every registration retroactively uninformed.
