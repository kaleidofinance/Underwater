# Posting the plates

Copy for the seven cards in `brand/nft.html`. The voice, the five rules and the
chain-naming split all come from [`x-launch.md`](x-launch.md) and are not restated
here; the findings the sequencing is built on are in [`x-growth.md`](x-growth.md).

One thing is different about these cards, and it changes the instruction attached
to them. The six `x-plate-*` cards are a sentence set large, so `x-launch.md` says
not to post the card and the bare text together — the text is stronger alone. These
carry **the art**, which is the product. Post the image every time.

Every number below is out of the contracts, and the ones that cost us something are
in on purpose. Where a claim would need a fairness promise the contract does not
make, the copy says what the mechanism is instead. See **What this copy will not
say** at the end, which is the important section.

---

## 1. The teaser — `x-nft-sealed.png`

Post this **before** the collection is announced. Finding 4: anticipation
outperforms arrival, and this card is a literal sealed object, which is the format
at its purest.

### The one to use

> You buy the tube.
>
> All 2222 look exactly like this until minting closes.

Fourteen words, one checkable number, and it volunteers the uncomfortable part in
the first line — you are buying something you cannot see. That is rule 3 doing the
work an adjective would otherwise do.

### Alt, if the first post has to carry the mechanic

> 2222 sealed survey tubes, and a trait table already committed to a hash.
>
> Which tube holds which drawing is decided after minting closes, so there is no
> moment in the mint worth timing.
>
> underwater.fun

### Do not

Do not add "soon." Do not add a date. `mintCloses` is a real deadline in the
contract and the moment it appears in a post it becomes a promise about a calendar
rather than a statement about a mechanism.

---

## 2. The announcement — `x-nft-collection.png`

### The one to use

> Underwater Plates. 2222 hydrographic surveys, drawn entirely on chain.
>
> All 2222 already exist. The trait table was committed to a hash before minting
> could open, so nothing about the art can change once demand is known.
>
> Three of them, rendered straight out of the sealed table:

The last line is doing something specific: it tells the reader the images are
output, not artwork made for the post. For a collection whose whole pitch is
pre-commitment, that distinction is the pitch.

### Short — better reach, less proof

> 2222 plates, all of them already drawn.
>
> The trait table hashes to a value fixed in the constructor, and the contract
> checks it before it will let anyone mint. The art cannot respond to demand.
>
> underwater.fun

### The footnote that has to travel with this card

If anyone asks about the numbers stamped on the previews — and someone will —
the answer is that they are **table slots, not plate numbers**, and the card says
so. `render.py` stamps `slot + 1`. The mapping from plate number to slot is the
offset `reveal()` draws after minting closes. Do not let a reply imply the preview
is plate 1068.

---

## 3. The mechanic — `x-nft-dissolve.png`

The strongest card in the set, and the one thing here no other collection has. Lead
the mechanic with this, not with `drown`.

### The one to use

> Your plate is your position.
>
> Attach a leveraged position and the ink starts reading it. Crisp in dry dock.
> Dissolving into plumes as the health factor falls. Gone when it liquidates.
>
> Nobody repaints it. The renderer reads Aave on every view.

### Alt — the numbers version

> One plate at six health factors. Same token, same traits, same owner.
>
> Below 1.4, a near-death dip can be engraved as a scar: at most one a day, at
> most eight ever. At 1.0 the plate can be burned.
>
> The art is a function of the position. There is no metadata server to update.

`SCAR_HF` is `1.4e18`, `SCAR_COOLDOWN` is `1 days`, `MAX_SCARS` is `8`, `DROWN_HF`
is `1e18`. All four are public constants in `UnderwaterPlates.sol`.

### The line worth saving for a reply

> A metadata server is a promise that somebody keeps paying for a server. This is
> a function of two on-chain reads.

---

## 4. The sharpest post on the account — `x-nft-drown.png`

### The one to use

> `drown(uint256)` is external and unpermissioned.
>
> When your health factor reaches 1.0, any stranger can call it, burn your plate,
> and mint themselves a trophy engraved with your plate number, the block, the
> health factor, and their own address.
>
> This is the mechanic. Not a side effect.

Every item in that list is a field in `UnderwaterTrophy.Kill` — `plate`, `block_`,
`healthFactor`, `hunter`. Nothing there is a flourish.

### Post it with the opt-in condition, always

> Two conditions, in the order the contract checks them:
>
> require dives[id].position != 0 — you attached a position
> require healthFactor <= 1e18 — Aave says it is gone
>
> A plate with nothing attached cannot be drowned by anyone. Attaching one is a
> choice, and this is what the choice costs.

**Do not post the burn without the first condition.** A card or a post that shows
only the health-factor check reads as though every plate in the collection is
exposed to a stranger, which is false and is the kind of false that gets screenshot
without the correction. The card itself carries both requires for this reason.

### Expected reception

This is the most repostable post here and it will also draw the angriest replies.
The flat register from `x-launch.md` is the answer: it is opt-in, it is disclosed
before you buy, and the trophy exists so that the burn has a counterparty rather
than being a deletion. Do not argue past that.

---

## 5. The trust post — `x-nft-provenance.png`

Repost-bait. Finding 6 is the whole reason this post exists in this form.

### The one to use

> Three things to check before you buy, all of them functions rather than
> promises:
>
> `seal()` refuses to open minting unless the traits in storage hash to a value
> fixed in the constructor.
> `reveal()` draws the plate-to-slot offset only once minting can no longer change
> who gets what.
> The contract holds no approval, moves no collateral, and reads Aave read-only.
> It cannot liquidate anybody.
>
> 0x9857a8af1cb7d1cbc92442a52248a74903b5544e7347ed133bbccf730dd2cfdd

### The companion post, and the one that buys the most trust

> The unflattering half of that: secondary royalty is 5%, hardcoded as
> `ROYALTY_BPS = 500` and reported through ERC-2981. The mint price is
> owner-settable under a 1 ETH ceiling.
>
> Both are in the contract. Neither is a surprise we were saving.

`ROYALTY_BPS = 500` and `PRICE_CEILING = 1 ether` are both public constants; the
price genuinely is settable, because it targets a dollar figure while ETH moves.
Publishing the ceiling alongside the fact that it is settable is what turns
"settable" from a red flag into a bounded parameter — the same move the launchpad's
fee-cap card makes.

---

## 6. Counted, not estimated — `x-nft-rarity.png`

### The one to use

> How many is rare, counted out of the sealed table rather than estimated from the
> weights it was drawn from:
>
> Satoshi — 35 of 2222
> Cut crystal — 62
> Unicorn figurehead — 65
> Gold leaf — 147
> Ink · Kraken — 195
>
> The table is public and it is sealed. Count them yourself.

Those five counts are out of `traits/traits.json` and were re-counted before this
document was written. The names are the exact strings `UnderwaterNames.sol` emits —
"Satoshi", not "Satoshi medallion" — because a post that says *count them yourself*
and prints a name that is absent from every trait filter has sent the reader
somewhere they cannot arrive.

### The line that stops this reading as insider knowledge

> Those counts have been public since before minting opened. The offset that maps
> plate numbers onto slots is the hash of the block before `reveal()` is called, so
> it does not exist yet.

### Never post

**"Aberration" is not a rarity tier and must never be posted as one.** It forces a
slot's pigment to gold leaf and writes no trait of its own, so nothing in the
packed table distinguishes an aberration from any other gold-leaf plate. 22 of 2222
is an unverifiable number and putting it in a post is the exact failure in finding
6. The countable number is 147.

---

## 7. The header — `x-nft-header-1500x500.png`

Swap the profile header to this when post 2 goes up, so the profile and the
announcement are visibly one thing — the same move `x-launch.md` makes with the
intro header. Switch back to `x-banner-1500x500.png` once the drop is over and the
account is a launchpad again.

---

## Two posts that are not cards

### Reply-bait

Finding 3: reposts and replies are different motives and almost nothing triggers
both. Every post above is written for reposts, so this is the counterweight.

> A plate whose owner gets liquidated is burned by ______.

Answer: a stranger. Same fill-in-the-blank shape as the highest reply-to-like post
in the whole sample, and unlike that one it has a correct answer that teaches the
mechanic to everyone reading the replies.

Alt, if a blank feels too cute:

> Name another collection where the art gets worse when you take on leverage.
>
> Genuinely asking — we think this is the only one and would like to be wrong.

### The co-brand

> 195 of the 2222 plates carry the Ink · Kraken emblem. Stamped on chain, drawn on
> chain, counted before minting opened.

Quotable by @inkonchain, which finding 7 says is the only distribution that chain's
account provides. **One judgment call for you, not for me:** the emblem set puts
Kraken's mark alongside Bitcoin, Ethereum, Robinhood, Uniswap, OpenSea and Binance,
which is an ordinary "marks of the category" trait category — but this post is the
one that deliberately points at it. It is already in the deployed contract either
way; posting it is the part that is still a choice.

---

## Sequence

Reply-bait and repost-bait alternate, per amendment 2 in `x-growth.md`.

| order | post | card | motive |
| --- | --- | --- | --- |
| 1 | the tube | `x-nft-sealed.png` | teaser |
| 2 | the announcement | `x-nft-collection.png` | repost — swap the header here |
| 3 | the blank | none | reply |
| 4 | your plate is your position | `x-nft-dissolve.png` | repost |
| 5 | `drown(uint256)` | `x-nft-drown.png` | repost, and the angriest replies |
| 6 | three things to check | `x-nft-provenance.png` | repost |
| 7 | the unflattering half | none | repost |
| 8 | counted, not estimated | `x-nft-rarity.png` | repost |
| 9 | the co-brand | none, or the header | @inkonchain |

Post 1 sits on its own for a day or two — that gap is the asset, not a delay.
Everything after that is one post every other day, as in `x-launch.md`.

Status line for any post that needs one, unchanged from `x-launch.md` because it is
the version that is checkable: *the contracts are on Ink Sepolia and we are
validating them in public before mainnet.* **Ink Sepolia** and **Ink Mainnet** name
networks; **InkChain** is brand register only.

---

## What this copy will not say

`reveal()` is `external` with no access control, and the offset is
`uint256(blockhash(block.number - 1)) % SUPPLY`. Once minting has closed, anyone may
call it — and a caller who reads the current block's hash before submitting gets a
**free option**: land in the block they aimed at and they get the offset they
computed, land a block later and they get a random one, which is what they would
have had anyway. `isRevealed` makes it one-shot, so this is not unlimited grinding.
It is a costless single roll, and the holder with the most plates is the one with
the most reason to take it.

So none of the copy above says the reveal cannot be gamed, that nobody can
influence which plate you get, or that the offset is random. What it says instead
is the mechanism: the offset does not exist until minting closes, and mint timing
cannot help you. Both of those are true.

The claim on the `#sealed` card — *no transaction position can be timed to land a
rare one* — is about **mint** position and is correct as written; minting earlier or
later cannot help anybody. It is not a claim about who calls `reveal()`.

Keep it that way. Finding 6 is a Community Note on the biggest post of the biggest
account in this category, attached because a fee was understated. A fairness promise
the contract does not make is the same shape of mistake with a larger blast radius,
and this collection would be making it on the one axis it is selling.
