# Allowlist selection criteria

**This is the document `/mint` refers to.** The waitlist panel tells everybody who
registers that the allowlist is "a Merkle tree built from this list under criteria
published before registration opened," that "arrival order is a receipt, not a
rank," and that **the rank is referrals** — how many real wallets you brought in.
This is those criteria. It is published before registration opens, its hash is
posted on chain before the waitlist contract exists, and every rule in it is a
function of public data — so the finished list is not something you have to take our
word for. You can rebuild it.

It says what it says and nothing more. Registering does not reserve a plate.

## The number

**2000 addresses.** `WL_ALLOCATION` reserves 2000 of the 2222 plates for the
allowlist phase, and `maxPerWallet` is set to **1** before the root goes up. 2000 ÷
1 = 2000. Both numbers are on chain and the mint page reads the second one directly
off the collection, so if this figure is ever wrong, the page will disagree with it.

That leaves **222 plates** for everything else — the treasury reserve and the public
phase together. The collection is deployed with `reserve = 0` for exactly this
reason: at a 2000-plate allowlist there is no room to also carve out a reserve, and
a plate held back is a plate the public phase does not get.

The **1** is the whole reason a selection exists at all. The constructor's ceiling
is 222, at which the same 2000 plates fit inside 10 addresses. 1 spreads them across
2000 people instead — one plate each, no address favoured — and that is also what
creates the problem this document solves: 2000 spots is a number that can run out
when 20,000 people register, and it is meant to.

## Rule 1 — if 2000 or fewer register, everybody is on it

No selection, no lottery, no ranking. Every address that registered goes into the
tree.

**This is stated first on purpose, and it is no longer the expected outcome.** The
earlier version of this list held 500 spots and opened by saying a contest probably
would not happen. This one is sized for the opposite: a waterdrop that draws far
more registrations than spots. Rule 1 is still written out in full, because criteria
that only exist once they are needed are not criteria — but if it fires, it means
the drop was quiet, and nobody was ranked against anybody.

## Rule 2 — if more than 2000 register

Then there is a procedure, and it is entirely mechanical. The rank is **qualified
referrals**, and the tiebreak is a **seeded draw**. Neither is ours to choose after
the fact.

**The snapshot block, `S`** — the block in which `UnderwaterWaitlist` was deployed.
Every qualification below is measured *at that block*. Registration cannot open
before the contract exists, so `S` is at or before the first possible registration:
nothing that makes a referral *count* can be manufactured after these rules are
known. Deploying with `WAITLIST_OPENS` blank makes registration open in `S` itself
and closes the gap entirely, which is why the runbook recommends it.

**The seed block, `B`** — the first Ink block whose timestamp is at or after the
waitlist's `closesAt()`. The **seed** is that block's hash.

`B` does not exist while registration is open, so nobody can register strategically
against it, and we cannot pick it: we do not sequence Ink. What we can do is name the
rule in advance and publish the value we got, which is this paragraph. The honest
limit is that Ink's sequencer *could* in principle influence a block hash; it has no
stake in who gets a discounted plate, and this is the strongest seed available
without asking every registrant to also submit a commitment, which would turn a
one-transaction intake into a two-transaction one and lose more people than it
protects.

**The draw** — for each registered address `a`:

```
draw(a) = uint256(keccak256(abi.encode(seed, a)))
```

64 bytes: the 32-byte seed, then the address left-padded to 32 bytes. The same
`abi.encode` convention as the Merkle leaves in
[`src/utils/MerkleProof.sol`](src/utils/MerkleProof.sol), so there is one encoding
rule to get right in this repo rather than two. **Lower draws win.** The draw does
not rank the list — the referral score does — but it breaks every tie, and there are
a great many ties, because most addresses refer nobody. Ties on the draw break on
the address ascending; draws are 256 bits and that will not happen, but an order
that is not total is not a procedure.

Each address has exactly one draw and keeps it whether it ranks on referrals or falls
into the tail. One number per address, plus one score, explains the entire result.

### The rank: qualified referrals

Every registration made through `registerWith(referrer)` is attributed on chain to
its referrer — `referrerOf(a)` and the indexed `Registered` event both carry it, so
the graph is readable without an indexer. **Your score is the number of addresses you
referred that were *real* at block `S`:**

```
score(a) = | { b : referrerOf(b) == a and qualified(b) } |
```

An address `b` is **qualified** at `S` if any one of these is true — the union, not
all three:

1. **It had transacted.** `eth_getTransactionCount(b)` at `S` is greater than zero.
   For an ordinary wallet this is the whole test: an account cannot open an Aave
   position or trade on the launchpad without first sending a transaction, so for an
   EOA the next two rules are already implied by this one.
2. **It carried Aave debt.** `getUserAccountData(b).totalDebtBase > 0` on the pool
   this collection reads, pinned in [`script/InkAave.sol`](script/InkAave.sol).
3. **It had traded the launchpad.** At least one `Trade` event from
   [`UnderwaterLaunchpad`](src/UnderwaterLaunchpad.sol) with `trader == b`, at or
   before `S`.

Rules 2 and 3 exist for **smart-contract wallets**. A Safe or other smart account
never sends EOA-style transactions — it is *invoked*, not a sender — so its
`eth_getTransactionCount` can read zero while it actively borrows and trades. Those
are exactly the wallets a leveraged position is likely to be run from, and the
waitlist contract welcomes them by design; rules 2 and 3 make sure the qualification
test does too, instead of silently discounting every Safe to zero.

**Order:** by `score` descending, then `draw` ascending, then address. **The top 2000
win.** So:

- **More qualified referrals is always a better rank.** An address with a higher
  score is placed above one with a lower score, whatever either drew. This is the
  headline property, and `script/select.py --self-test` checks it: gaining a
  qualified referral, holding every other input fixed, never moves an address from
  selected to unselected.
- **A referral from a wallet that was not real at `S` is worth nothing.** It does not
  raise your score and it does not lower it. This is the entire anti-sybil model:
  registering 500 fresh wallets and pointing them all at yourself buys 500 draws in
  the tail lottery and *zero* rank, because none of them were real at `S`. To buy
  rank, each of those wallets has to have been a funded or active account *before the
  snapshot block* — before these rules were even knowable as final.
- **If you have referred nobody, you are in a lottery for whatever the ranked do not
  fill.** Score zero is the common case — most people refer no one — and every score
  the ranked do not consume is decided by nothing but the draw. This mirrors what the
  contract already does with the phase itself: allowlist plates the allowlist does
  not use roll into the public mint.

Rule 1 is just this procedure with 2000 or fewer registrants — the ranked never fill
the list, the tail lottery reaches everyone, and everybody is taken. There is one
procedure, not two.

## What these criteria deliberately do and do not do

**They reward referrals — this is a change, and it is deliberate.** The waitlist
contract's own comments argue the other way: that rewarding referrals "would make
every fake registration worth something, which is exactly the incentive a list like
this cannot afford." That objection is correct about *raw* referrals, and it is the
reason the score counts **only qualified** ones. A fake registration is worth
nothing here. A referral is worth a spot only when the referred wallet was already a
real account on Ink before any of this opened — which is not something a farm spins
up for the price of gas. The contract still stores the raw tally as a scoreboard,
because a scoreboard we could edit is not one; this document is what reads it, and it
reads it through the qualification filter above.

**They bound sybils, and no wording here pretends they eliminate them.** Nothing in
public chain data distinguishes 200 wallets held by one person from 200 people. What
the qualification rule does is price the attack: a rank-buying registration is not a
gas fee, it is a wallet that was funded or active before block `S`. That is bounded,
it is not zero, and pretending it is zero would be worse than saying so. The tail
lottery has the same bound it always did — an address is worth the gap between the
allowlist price and the public price, times one plate, and that is what a farm is
buying with each registration and each draw.

**They do not weigh anything off chain.** No Discord role, no follower count, no
form, no application, no email. The two social steps on the waitlist panel are on the
registrant's honour and gate nothing here. None of these can be checked by the person
they are being applied to, and a criterion that cannot be checked is discretion
wearing a procedure's clothes.

**They do not rank by arrival order.** Registration position is recorded on chain and
appears in every snapshot, and it is a receipt: proof you registered and when. It is
not an input to the score or the draw. First-come-first-served rewards whoever
happened to be awake, and a 7-day window that is really a 90-second window is a worse
deal than a ranking honestly described as one.

**They do not check whether an address can hold a plate.** The collection mints with
`_safeMint`, so a contract that does not implement `onERC721Received` cannot receive
one. Register the address you actually want on the list. A spot in the tree is not
transferable to another address and there is no appeal for one that turns out not to
work — a Merkle root cannot be edited, only replaced wholesale.

## Not selected

The public phase. It is whatever the allowlist did not use plus the ~222 plates the
allocation leaves, at `price` rather than `wlPrice`, and it opens after the
allowlist — [`openPublicMint`](src/nft/UnderwaterPlates.sol) is one-way, and the
allowlist stays open once it fires, so being in the tree is a right to the discounted
price, never a deadline.

If a second wave is ever run, it is a new root over a new list under criteria
published the same way, and this document does not promise one.

## Rebuilding the result

Three artifacts get published when the list does: the snapshot, the seed, and the
tree. With them and this document, the selection is reproducible by anyone, including
someone who thinks we cheated.

```bash
npm run waitlist -- --waitlist <address> --rpc <ink-rpc>
```

The complete intake, straight off the contract, pinned to one block —
`script/waitlist-snapshot.txt`. It records each registrant's address, arrival
position, and **referrer**, and it does not filter, so it is checkable against the
chain on its own.

```bash
python script/select.py --snapshot script/waitlist-snapshot.txt --seed 0x<blockhash> \
  --launchpad <launchpad-address>
```

The procedure above, applied. It reads the referrer edges from the snapshot, grades
each referred wallet's qualification at `S` from public chain state, and prints every
registrant's score, draw and rank — so a disagreement about the result lands on a
specific line rather than on the whole list. It writes `script/whitelist.txt`.

```bash
python script/whitelist.py script/whitelist.txt
```

The tree and every proof, into `web/public/whitelist.json` — the file the mint page
serves. It re-verifies each proof the way the contract will before writing anything.

```bash
PLATES=… WL_ROOT=… WL_MAX_PER_WALLET=1 forge script script/SetWhitelist.s.sol --broadcast
```

The root goes up with `maxPerWallet = 1` in the same broadcast, and the script
re-checks one member's proof against the root before broadcasting it.

**Every step is deterministic given the seed.** Same snapshot and same seed, same
root — which means the check that matters is not reading our output but running the
commands and comparing 32 bytes against what is on chain.

## Publication

This file's `keccak256` is posted on chain in a zero-value transaction from the
deployer before `UnderwaterWaitlist` is deployed, so the hash's block number is lower
than `S` and lower than any registration. The transaction and the hash go in the
announcement alongside the waitlist address. Hash the file yourself:

```bash
cast keccak "$(cat ALLOWLIST.md)"
```

Git commit dates are set by whoever commits, so the repo alone cannot prove this
document predates the window. The on-chain hash can, and that is the only reason it
exists.

**Amendments before registration opens** are republished the same way: a new hash, a
new transaction, both before `S`, with the change described. **After registration
opens, this document is final.** Not because it is perfect — because the promise on
the page is that the rules were fixed before anyone registered under them, and a rule
changed afterward makes every registration retroactively uninformed.
