# What actually farms reactions on X

Field notes from seven accounts, read on 2026-08-29, plus what transfers to an
account that has committed to not shouting.

This is the companion to [`x-launch.md`](x-launch.md). That file decides what we
say. This one is about the mechanics of being seen saying it — and about the
uncomfortable fact that most of the tactics that demonstrably work are ones our
voice rules forbid.

---

## How this was gathered, and what it cannot tell you

X is behind a login wall, and the mirrors that used to get around it are gone —
XCancel was served a cease-and-desist by X Corp. on 24 August 2026 and is down.
The numbers below came from logged-out renders of seven profiles, which surface
**the five most recent posts and nothing more**.

So the honest limits:

- **Five posts per account, one snapshot.** This is a sample, not a study. No
  account's median is knowable from it.
- **View counts are cumulative and unaligned.** A post from 56 minutes ago is
  compared with one from two weeks ago. Fresh posts are systematically
  understated.
- **Pinned posts are not comparable to anything.** Every profile visitor loads
  the pin, so its view denominator is inflated by traffic that never had any
  intention of engaging. Every pinned post in this sample has a terrible
  engagement ratio, and that is mostly an artifact of pinning rather than
  evidence against the post.
- **Two things I could not verify at all** and have therefore left out: Kaito's
  mindshare scoring formula (Cloudflare-gated) and X's current ranking weights
  (the 2023 open-source release does not contain them, and I am not willing to
  quote remembered numbers as fact). Everything below is inferred from observed
  behaviour, not from a published weight.

With that said, the pattern across the sample is strong enough and consistent
enough across five unrelated accounts to act on.

---

## The numbers

Ordered by like rate — likes ÷ views — which is the closest thing to a
size-independent measure available here. `R/L` is replies ÷ likes: how *argued
with* a post is, relative to how *approved of* it is.

| account | post | likes | views | like % | R/L |
| --- | --- | --- | --- | --- | --- |
| base | `1 second 1 cent 24/7` | 866 | 52K | **1.67%** | 26% |
| base | `Based weekend loading 🟦×11⬜ 97%` | 1.4K | 88K | **1.59%** | 22% |
| pump.fun | `not now babe I'm locked in` + image | 1.8K | 126K | **1.43%** | 16% |
| pudgy | `Tomorrow 👀` + image | 1.1K | 78K | **1.41%** | 10% |
| pump.fun | video, no caption at all | 449 | 32K | **1.40%** | 40% |
| pudgy | schleich® figurine partnership | 701 | 51K | 1.37% | 10% |
| pudgy | `P____ M______ (right answers only)` | 432 | 38K | 1.14% | **56%** |
| pump.fun | `why would anyone doomscroll tiktok when…` | 621 | 68K | 0.91% | 40% |
| pudgy | `$PENGU now live on Robinhood chain` | 2.2K | 242K | 0.91% | 8% |
| monad | `Update: @monad_xyz is now @monad` | 2.3K | 269K | 0.86% | **43%** |
| base | `Base is for every stablecoin` (partner QT) | 350 | 45K | 0.78% | 32% |
| pump.fun | `Apple Pay up to $1500 on the Pumpfun app` | 1.1K | 153K | 0.72% | 21% |
| berachain | GIF, no caption | 906 | 129K | 0.70% | 33% |
| berachain | `Money.` + image | 246 | 36K | 0.68% | 25% |
| berachain | daily APY rates card | 157 | 23K | 0.68% | 9% |
| base | Jesse on the path to $100B TVL | 575 | 85K | 0.68% | 26% |
| berachain | $BUSD rename, thread opener | 486 | 83K | 0.59% | 19% |
| berachain | `Cosmos EVM vulnerabilities do not affect Berachain` | 161 | 29K | 0.56% | 13% |
| pudgy | Target nationwide TCG rollout (pinned) | 2.5K | 676K | 0.37% | 16% |
| base | Bitwise CIO on tokenized stocks (pinned) | 423 | 128K | 0.33% | 17% |
| pump.fun | Callout Rewards launch (pinned) | 2.9K | 1M | 0.29% | 27% |

Split the sample by one rule — does the post carry a link, a CTA, a partner tag,
or product news? — and the two halves separate cleanly:

- **No link, no CTA, no news** (n=9): median like rate **1.40%**
- **Announcements** (n=12, including the three pins): median **0.68%**

**A 2.06× difference, in favour of the posts that cost nothing to make.** The
finding survives the obvious objection: drop the three pinned posts, whose view
counts are inflated by profile traffic, and the announcement median only rises to
0.72% — still 1.95×.

---

## Seven findings

### 1. The best-performing post on the biggest chain account is a joke progress bar

`Based weekend loading 🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦⬜ 97%` — 1.4K likes on 88K views. It
contains no information. It outperformed a video of Base's own lead talking about
a path to $100B TVL by a factor of 2.3 on like rate.

This is the finding people take the wrong lesson from. The lesson is not "post
memes." It is that **the timeline rewards posts that ask nothing of the reader** —
no click, no comprehension, no decision. A progress bar is legible in a quarter of
a second and requires no belief.

### 2. But the *second* best is a specification

`1 second 1 cent 24/7` — 866 likes on 52K views, the highest ratio in the sample.
Nine words, three of them numbers, no media, no emoji, no link.

This is the single most important post in the whole study for us, because it is
the existence proof that **you do not have to be funny to be cheap**. It is a spec
sheet with the cadence of a chant. It asks nothing of the reader for the same
reason the progress bar does — it is instantly legible — but what it deposits is a
fact.

Our equivalent already exists and we have been burying it in paragraphs:

> One curve.
> 4 ETH to graduate.
> 25×, exactly.

### 3. Announcements get reposted; questions get replied to

The split is clean and it runs in opposite directions.

- Pudgy's schleich® partnership: **128 reposts, 72 replies.**
- Pudgy's `P____ M______ (right answers only)`: **25 reposts, 244 replies.**

Same account, same week: **5.1× the reposts** one way, **3.4× the replies** the
other. A repost means *I want my followers to know this*. A reply means *I want to
be seen in this thread*. They are different motives and almost nothing triggers
both.

The highest reply-to-like ratio in the entire sample — 56% — is a fill-in-the-blank
with no media, no information, and no product in it.

### 4. The teaser is the most efficient post format in existence

Pudgy's `Tomorrow 👀` + image: 1.1K likes on 78K views. The schleich® partnership
announcement that followed it about seventeen hours later — real news, real product
photography, a link to buy — got **701 likes on 51K views**. Fewer likes in
absolute terms than the two-word post that preceded it. (That the teaser was
teasing *that* announcement is an inference from the timing, not something either
post states.)

Robinhood does the same thing with a date and nothing else: `Mission control,
accelerate engines. September 29, 2026. Stay tuned.` Abstract does it in two
words: `You in?`

The anticipation outperforms the thing. Which is worth sitting with, because it
means the pre-launch period is not a weakness for us — it is the highest-leverage
window we will ever have, and we are in it right now.

### 5. Hyperliquid proves the flat voice works — and shows what it costs

Hyperliquid is the most commercially successful thing in the category and its
account is almost exactly the voice `x-launch.md` prescribes: no emoji, no
exclamation marks, one to three sentences, metrics stated and not celebrated,
about one post a day, templated listings, nearly every post carrying an image.

A post announcing that RWA open interest hit an all-time high of $3.6B and total
open interest a 2026 high of $11B is, in substance, the entire post. It works
because $11B is the argument.

**The catch, stated plainly:** flatness is a claim on the reader's attention that
only numbers can cash. Hyperliquid has the numbers. We have zero users and a
testnet. If we simply copy the register we get the austerity without the
authority — a very quiet account.

The resolution is that until we have traction numbers we substitute **mechanism**
numbers, which we have in abundance and which are equally checkable. `4 ETH →
25×, exactly` is not traction, but it is arithmetic, and arithmetic is the thing
the flat voice runs on.

### 6. pump.fun's biggest post carries a Community Note about its fees

The pinned Callout Rewards launch — 2.9K likes, 1M views, the widest-reaching post
in the sample — has a Community Note attached stating that pump.fun charges 0.3%
to 1.25% on Solana tokens, **not the 0% the post claimed**.

Our single largest competitor's flagship post is fact-checked by the platform for
lying about fees, in front of a million people, permanently.

This is not a tactic to copy. It is the reason our thread post 4/ — the complete
fee schedule, volunteered, with an invitation to find one we missed — is worth more
than any clever thing in this document. The contrast writes itself and we should
never mention them by name while making it.

It is also a warning we very nearly walked into. The first draft of that post, and
of the fee card below, listed three fees; the contracts have four. Volunteering an
incomplete list is worse than volunteering nothing, because it invites exactly the
correction that made pump.fun's pin an exhibit.

### 7. Ink's own account is 100% ecosystem amplification — and runs no creator programme

Every post on @inkonchain in the sample is a quote-post of an ecosystem project:
Zerion's agents, Nado's trading rewards, Arcana's execution engine, Kraken Wallet.
The account has 4,557 posts and a bio reading *"The network for global finance.
From the team that brought you Kraken."*

Two consequences, both actionable:

- **Ink's timeline is a distribution channel that costs nothing but a quotable
  post.** The account's entire editorial model is amplifying builders. Being
  amplified is not a favour to ask for — it is the thing they are looking for
  material to do.
- **Ink pays for nothing.** I checked `/builders` and `/community`: no grants
  page, no ambassador scheme, no points season, no creator rewards. Only a brand
  kit. The airdrop badges on the site belong to Nado and Tydro, not to Ink. So
  there is no attention programme to farm here, and no budget to wait for.

There is a positioning note buried in that bio, too. Ink markets itself as
infrastructure for **global finance**, not as a memecoin chain. A launchpad whose
whole pitch is *published math* is the most on-register thing that could launch on
it. That is worth saying out loud in the intro post, and it is nearly the opposite
of the pitch a launchpad would make on Solana.

---

## The mechanics, separated into ones we can use and ones we cannot

The category's engagement tactics divide cleanly once you ask what each one costs
in credibility.

### Use these

| mechanic | evidence | our version |
| --- | --- | --- |
| **Spec-as-slogan** — numbers with the cadence of a chant | base `1 second 1 cent 24/7`, 1.67% | `One curve. 4 ETH. 25×, exactly.` |
| **The teaser** — a date or two words, nothing else | pudgy `Tomorrow 👀` beat its own announcement | a block height, a countdown of curves remaining, `Fig. 2` with no caption |
| **Ask a question with one correct answer** | pudgy fill-in-blank, 56% R/L | `Name a launchpad that publishes its fee schedule.` |
| **The recurring series** | berachain's daily APY card; hyperliquid's templated listings | one specimen card per graduation — already designed for this |
| **Be quotable by the chain** | @inkonchain amplifies builders exclusively | tag Ink on every milestone; make the card do the work |
| **Correct the record flatly** | berachain's Cosmos-EVM post: low engagement, high trust | our fee-schedule post, and any incident report |
| **Motion, not stills** | every monad post in the sample was video | `x-curve.gif` — already rendered |

### Refuse these

- **Emoji and slang as register.** `not now babe I'm locked in` works for pump.fun
  precisely because it is pump.fun. It is the one thing that would make us
  indistinguishable from the accounts we are positioned against, and positioning
  is the only asset a zero-follower account has.
- **Follow-to-enter giveaways and engagement pods.** They work and they
  permanently change what the account is. `x-launch.md` already rules this out and
  nothing in the data argues with it.
- **Paying for mindshare before there is a product.** Kaito Studio campaigns run
  to $200K in reward pools — MEXC is running two concurrently. Buying attention
  for a testnet means paying strangers to describe something they cannot use. Buy
  it, if ever, at mainnet, when the thing being described is real.
- **Any claim a Community Note could attach to.** See finding 6. The specific
  discipline: never state a fee, a multiple, or a status without it being the
  number in the contract.

---

## Six posts, written to these findings

Drafted to fit the voice in `x-launch.md`. No emoji, no hype, every one of them
cheap to produce.

Each one is also rendered as a 1600×900 card — `x-plate-spec`, `-teaser`,
`-question`, `-locked`, `-everyfee`, `-chain`, from `brand/plates.html`. Post the
card *or* the bare text, never both: the cards exist because 16:9 is the only ratio
X shows uncropped and a new account needs to be recognisable, but finding 1 says
the text alone is the cheaper post and cheap is what wins here.

**The spec chant** — our `1 second 1 cent 24/7`

> One curve.
> 4 ETH to graduate.
> 25×, exactly, every time.

Nothing else. No link, no image, no explanation. If it needs the explanation it is
not the post.

**The teaser** — no image, no context

> Fig. 2 is a token that graduated.
>
> Not yet. Soon.

**The question with one right answer**

> Name a launchpad that publishes its complete fee schedule where you can find it
> before you deposit.
>
> Genuine question. We will wait.

Bait, and honest bait: we can answer it about ourselves and almost nobody can.

**The refusal** — reposts, not replies

> Things people call locked liquidity:
> a 12-month timelock. A multisig the team controls. A vesting contract with an
> admin function.
>
> Things that are burned:
> 0x…dEaD

**The unflattering number** — the highest-trust post we can make

> Every fee underwater.fun charges:
>
> 1% per trade. 5% of the 4 ETH at graduation. About $2 to create a token.
> 0.30% on swaps after the pool opens — 0.25% to LPs, 0.05% to us.
>
> That is the list. If you find a fifth, it is a bug and we want the report.

The first draft of this post listed three fees and dared the reader to find a
*sixth*, which is both wrong and wrong in the direction finding 6 punishes. There
are four: three settable ones in `UnderwaterLaunchpad.sol` and the DEX's hardcoded
0.30% swap fee, of which `_mintFee` sends us 1/6. Count them out of the contracts
every time this post is edited.

*Image:* `x-plate-everyfee.png`, which goes further than the text and publishes the
hard cap beside each current value — a fee schedule the owner can change is not a
schedule unless you also say by how much.

**The chain post** — written for @inkonchain to quote

> Ink calls itself the network for global finance.
>
> So the launchpad on it publishes its math: price ∝ (1 + ETH)², graduation at
> 4 ETH, LP burned. Checkable before you buy, not explained after you lose.
>
> Live on Ink Sepolia. Ink Mainnet next.

---

## What this changes about the cadence

Three amendments to the plan in `x-launch.md`:

1. **The teaser window is an asset, not a delay.** Finding 4 says anticipation
   outperforms arrival. Post the spec chant and one teaser *before* the
   introduction card, not after it.
2. **Reply-bait and repost-bait are different posts.** Stop trying to write one
   post that does both. Alternate: a specification or a refusal for reposts, a
   question or a blank for replies.
3. **The pinned post is not the important post.** Every pinned post in the sample
   has the worst ratio on its account. Pin the formula because it is the correct
   front door for a first visitor, and then stop thinking about it — the
   distribution comes from the cheap posts in between.

One thing this document deliberately does not do is give you a target. Follower
counts respond to being interesting over months, and every tactic that moves them
in a week is on the refuse list.
