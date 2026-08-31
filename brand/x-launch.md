# Starting on X

Everything here is written for an account with no followers yet, which is a
different problem from an account with an audience. You cannot drive volume you
do not have. What you can do is arrive looking like the only serious thing in a
category full of rocket emoji — and let the first hundred people who find you
feel like they found something.

That is the whole strategy, and it is also why the voice below is what it is.

---

## The voice

The category has one register: shouting. `🚀 STEALTH LAUNCH 🚀 100X 🚀 LP LOCKED
🔒 DEV BASED 🔥`. Every project sounds identical, which means the register itself
carries no information — and an audience that cannot tell projects apart defaults
to distrusting all of them.

So underwater.fun does not shout. It **publishes**. The brand is a technical
plate: `Fig. 1`, a real formula, an axis with real units, gold used once. The
banner already does this. The account should read like pages torn out of the same
document.

Five rules:

1. **A number instead of an adjective.** Not "insane returns" — "4 ETH to
   graduate, which is 25× exactly." The second one is checkable, which is what
   makes it land.
2. **No emoji.** Not as a style preference — as positioning. It is the single
   cheapest signal that this account is not the other accounts.
3. **Say the unflattering part.** Fees, testnet status, what the protocol does
   *not* do. Every project claims transparency; almost none volunteers a number
   that costs them something. Doing it once buys more trust than ten posts of
   claiming it.
4. **Never call it a rocket, a gem, or a moon.** It is a curve, a pool, and a
   burn.
5. **The image does the talking.** Every post below has an image, and the image
   is a figure — not a screenshot of a chart going up.

One deliberate exception: when someone else is loud at you, stay flat. A dry
one-line reply from a specimen-sheet account beats an argument.

`x-growth.md` is the counterweight to this section. It measures what the category
actually gets rewarded for, finds that the cheap posts beat the polished ones by
about 2×, and works out which of those mechanics survive contact with the five
rules above. Short answer: the formats transfer, the register does not — and Base's
best post in the sample is a specification, not a joke, which is the opening we
need.

### Naming the chain

**InkChain** in the brand register — "a launchpad on InkChain", the lockup, the
kicker. **Ink Mainnet** and **Ink Sepolia** whenever the sentence names an actual
network: where the contracts are, where a pool opens, what a wallet has to be
switched to.

The two are not interchangeable, and the reason is the one thing this account
sells. "Live on InkChain" is true of a testnet deployment and reads as though it
is not; "Live on Ink Sepolia" cannot be misread. Brand words can be warm. Status
words have to be checkable — which is rule 1 again, applied to the chain instead
of the numbers.

Same split in the app: `web/lib/chains.ts` names the networks Ink Mainnet and Ink
Sepolia because those strings end up in a wallet prompt and a network switcher.
Nothing there says InkChain.

---

## The introduction post

The very first thing on the account, posted before the pin and before the thread.
Its job is not to explain the protocol — it is to establish that this account
belongs on InkChain and that something is coming. The card does the introducing;
the text just has to not undercut it.

*Image:* `x-intro-1600x900.png` — the `underwater.fun × InkChain` lockup, with the
official InkChain mark.
*Header at the same time:* `x-intro-header-1500x500.png`, so the profile and the
first post are visibly one thing.

### Long — the one to use

> A launchpad on InkChain where the math is published before you buy, not
> explained after you lose.
>
> One curve: price ∝ (1 + ETH)²
> 4 ETH to graduate, which is 25×, exactly, every time.
> Then the pool opens and the LP burns to 0x…dEaD.
>
> Live on Ink Sepolia now. Ink Mainnet next.
>
> underwater.fun

### Short — better reach, less proof

> Coming to InkChain: a launchpad that publishes its math.
>
> One curve. 4 ETH to graduate. The LP burns on the way out.
>
> Ink Sepolia now, Ink Mainnet next. underwater.fun

### Teaser — if you want to post the card with almost nothing

> underwater.fun × InkChain
>
> One curve, published in full before anyone buys.
>
> Soon.

Three things this copy deliberately does. It says **Ink Sepolia** out loud, because
an anticipation post that implies mainnet is open costs more than it earns the
first time somebody clicks through and cannot trade. It puts a **checkable
number** in the first two lines. And it never says *soon* without also saying
what is already true — "soon" alone is the single most discounted word in the
category.

Do not put a date on it until the date is certain. A missed date is the only
mistake in this whole document that cannot be walked back.

---

## The pinned post

This is the one that has to be right, because for the next few months it is the
entire first impression. Three candidates, in order of preference.

### A — the formula (recommended)

> A bonding curve is a promise about price.
>
> Ours is written down:
>
> price ∝ (1 + ETH)²
> 4 ETH raised → graduation
> which is 25×, exactly, every time
>
> Then the pool opens and the LP burns.
>
> underwater.fun — on InkChain.

*Image:* `x-post-curve.png` (Fig. 1, the curve plate).

Why this one: it opens with a sentence nobody in the category writes, and the
payoff is a fact rather than a claim. "25×, exactly, every time" reads like hype
and is arithmetic — the curve is quadratic over a virtual 1 ETH reserve, so
raising 4 ETH multiplies price by (1+4)²/(1+0)² = 25. Anyone who checks finds it
true, and the people who check are the people worth having.

### B — the refusal

> Most launchpads hide the math.
>
> We printed it on the wall.
>
> One curve, published. 4 ETH to graduate. Liquidity burned to
> 0x…dEaD on the way out — not locked, not vested, burned.
>
> underwater.fun

*Image:* `x-banner-1500x500.png` cropped to 16:9, or the curve plate.

Why: "not locked, not vested, burned" is the sharpest three-word distinction in
the space, because *locked* is what rug-pullers say. Slightly more combative than
A, which is a reason to use it and a reason not to.

### C — the plate

> Fig. 1 — price against ETH raised.
>
> Everything else on this account is a footnote to this.
>
> underwater.fun

*Image:* the curve plate, full bleed, nothing else.

Why: the most confident version and the biggest gamble. Works if the image is
strong enough to carry it alone. Good as a *later* post; risky as the only thing
a first visitor sees.

---

## The opening thread

Post this second, quote-tweeting the pin. Six posts. Each one is a fact, not a
pitch.

**1/**
> Six things about underwater.fun, in order of how much they cost you.

**2/** — the curve
> The price is a function, not an auction.
>
> 800M of the 1B supply sells on the curve. 200M is held back for the pool.
> Nobody gets a discount for being early to the block — being early to the
> *curve* is the discount, and it is the same curve for everyone.

*Image:* the curve plate.

**3/** — graduation
> At 4 ETH raised, the curve closes itself.
>
> The ETH and the held-back 200M go into a real pool on InkChain. The LP tokens go
> to 0x000000000000000000000000000000000000dEaD.
>
> Burned. There is no key, no timelock, no multisig. The liquidity cannot leave
> because there is nobody left who could move it.

*Image:* `x-post-graduation.png`.

**4/** — the fees, all of them
> 1% on every trade.
> 5% of the 4 ETH at graduation.
> ~$2 to create a token.
> 0.30% on swaps once the pool is open — 0.25% to LPs, 0.05% to us.
>
> That is the complete list. If you find a fifth fee, it is a bug and we want the
> report.

*Image:* `x-post-fees.png`.

Why this post matters more than it looks: nobody volunteers this. Publishing the
whole fee schedule as a *flex* inverts the usual dynamic where fees are something
users discover. Expect this to be the most screenshotted post in the thread.

**The fourth line is there because the first draft of this post did not have it,
and that is exactly the failure it is warning about.** Three of the fees are the
launchpad's — `tradeFeeBps`, `graduationFeeBps`, `creationFee`, all owner-settable
within hard caps in `UnderwaterLaunchpad.sol`. The fourth belongs to the DEX and
starts applying only *after* graduation: 0.30% hardcoded in
`UnderwaterLibrary.getAmountOut`, of which `UnderwaterPair._mintFee` mints us 1/6
of the growth in √k whenever `feeTo` is set, which it is. It is genuinely easy to
forget, because it lives in different contracts and starts later — and a post that
says "complete" while omitting a fee is the one thing on this account that cannot
be walked back. Re-read the contracts before this post goes out, not the previous
draft of the post.

**5/** — the honest one
> Status, plainly: the contracts are live on Ink Sepolia and we are validating
> them in public before mainnet. Launching real money is not open yet.
>
> We would rather be six weeks late than be the fourth story this month.

**6/** — the ask
> If you build, break, or trade: follow along. The interesting part starts when
> the first curve graduates on Ink Mainnet, and we will post the block it happens
> in.
>
> underwater.fun

---

## Standalone posts, once the thread is up

Post one every day or two. Each is self-contained — no thread required, which is
what makes them shareable.

**The 25× post**
> "25×" is a marketing number everywhere except here, where it is a consequence.
>
> Quadratic curve. Virtual reserve of 1 ETH. Graduation at 4.
>
> (1 + 4)² ÷ (1 + 0)² = 25
>
> Not a target. An identity.

**The burn-address post**
> Things people call locked liquidity:
>
> — a 12-month timelock
> — a multisig the team controls
> — a vesting contract with an admin function
>
> Things that are actually burned:
>
> — 0x…dEaD

**The "what we don't do" post**
> underwater.fun has no presale, no team allocation, no whitelist for the curve,
> and no way for us to touch a pool after it graduates.
>
> The uncomfortable corollary: if a token you bought goes to zero, that is the
> market, and there is no one to appeal to. We would rather say that now.

**The InkChain post**
> Why InkChain: an L2 where a 4 ETH graduation is not eaten by the gas it takes to
> get there. A curve only works if the small trades near the bottom are worth
> making.

**The specimen post** — recurring format, the account's signature
> Take any graduated token's share card and post it with one line of commentary.
> The cards are already designed for this: they carry the art, the price, the
> depth bar and the gold GRADUATED badge. Paste the token URL and X unfurls it —
> no image upload needed.

That last one is the compounding one. Once mainnet is live, every graduation is a
post that writes itself, and the cards make a feed of them look like a series.

---

## Cadence

| when | what |
| --- | --- |
| before day 0 | avatar + `x-intro-header-1500x500.png` up, so the profile is dressed before the first post lands |
| day 0 | the introduction post |
| day 0, a few hours later | pin post A, then the thread |
| day 1–14 | one standalone post every other day, from the list above |
| at the plates drop | its own nine-post sequence — [`x-plates.md`](x-plates.md), starting with the tube |
| ongoing | reply to InkChain ecosystem accounts — flat, factual, never promotional |
| at mainnet | the block number the first curve graduates in |
| after that | one specimen card per graduation |

Do not buy followers and do not run a giveaway. Both work, and both permanently
change what the account is — an audience assembled by a giveaway is an audience
that leaves when the giveaways stop, and the specimen-sheet voice cannot survive
being that account.

---

## Images

Rendered by `node brand/render.mjs`. Sizes are what X actually wants:

| file | size | use |
| --- | --- | --- |
| `x-intro-1600x900.png` | 1600×900 | **the introduction post** — the × InkChain lockup |
| `x-intro-3200x1800.png` | 3200×1800 | the same card at 2×; upload this if X takes it |
| `x-intro-header-1500x500.png` | 1500×500 | profile header, matching the intro post |
| `x-banner-1500x500.png` | 1500×500 | profile header, the Fig. 1 version |
| `x-banner-3000x1000.png` | 3000×1000 | header, retina |
| `mark-plate-400.png` | 400×400 | avatar (X crops to a circle) |
| `x-post-curve.png` | 1600×900 | the pin, and thread 2/ |
| `x-post-graduation.png` | 1600×900 | thread 3/ |
| `x-post-fees.png` | 1600×900 | thread 4/ |
| `x-plate-spec.png` | 1600×900 | the spec chant — post this *before* the introduction card |
| `x-plate-teaser.png` | 1600×900 | the teaser — Fig. 2 with nothing in it |
| `x-plate-question.png` | 1600×900 | the question, with the blank drawn |
| `x-plate-locked.png` | 1600×900 | the refusal |
| `x-plate-everyfee.png` | 1600×900 | every fee **and its ceiling** |
| `x-plate-chain.png` | 1600×900 | the co-brand, for @inkonchain to quote |

The six `x-plate-*` cards are the posts drafted at the end of `x-growth.md`, and
they come with one instruction attached: **do not post the card and the bare text
together.** The study found media-light posts outperform, and the spec chant in
particular is strongest as nine words with no image at all. The plate is for the
timeline, where 16:9 is the only ratio shown uncropped and a recognisable card is
how a new account gets recognised at all. The bare text is for the reply, the
quote, and the second time we say it.

Two headers ship because they answer different questions. The intro header names
the chain and reads as an arrival; the Fig. 1 header is the one to switch to once
the account has said what it is and the curve can carry the space alone.

### The plates cards

The seven `x-nft-*` cards are a separate drop with its own sequence, and their copy
is in [`x-plates.md`](x-plates.md) — including the section that matters most there,
which lists the claims about the reveal that the contract does not support. They
also invert the instruction above: those cards carry the **art** rather than a
sentence, and the art is the product, so the image goes with every one of them.

The InkChain half of the lockup uses the **official mark**, at its full 512px —
`brand/ink-mark.png`, the same asset the app's network switcher draws (see
`web/components/ChainIcon.tsx`). It stays a raster and it stays full-colour
purple: the upstream "SVG" is a PNG in a wrapper, so there is nothing to trace,
and a logo recoloured to fit our palette stops being the logo. It is the only
saturated colour on the card, which is the point — the co-brand reads as a real
chain's mark sitting next to ours, not as an illustration of one.

## Motion

Rendered by `node brand/animate.mjs` from `brand/curve-anim.html` — five seconds
of one launch running from nothing to graduation, driven by the protocol's actual
formula rather than a drawing of it.

| file | what | where |
| --- | --- | --- |
| `x-curve.gif` | 50 frames, 10fps, 800px | **the X video post.** X transcodes uploaded GIFs to MP4 server-side and autoplays them |
| `x-curve.webp` | 150 frames, 30fps, 1000px | the site — animated WebP, smaller and sharper than the GIF |
| `x-curve.webm` | VP9, 1200×675 | Discord, and any embed that takes a container X will not |
| `x-curve-poster.png` | 1200×675 | the final frame, for thumbnails and anywhere motion will not play |

**There is no MP4.** The encoder here is Chrome's `MediaRecorder`, and headless
Chrome answers `isTypeSupported("video/mp4;codecs=avc1")` with `true` and then
records zero bytes — it has no H.264 encoder behind the claim. `animate.mjs`
tries each container for real and rejects any output under 4KB, so this fails
loudly rather than writing an empty file. Until there is an ffmpeg on the box,
**the GIF is the postable motion asset**, and it is a real one: X's own pipeline
converts it to a looping MP4 on upload.

Two things about X that constrain this:

- **X does not accept an animated header or an animated avatar.** Both are
  flattened to a still. Motion only reaches the timeline as a *video post*, so
  there is no point rendering an animated banner — the moving assets are for the
  site, Discord, and video posts.
- **A 16:9 image is shown uncropped in the timeline**; anything squarer gets
  centre-cropped in the preview. Hence 1600×900 for every post card.
