# Brand

The mark is **a drop of ink, half submerged**. Ink is the chain, water is the
brand, and the waterline is the one place they meet — drawn as a change of
colour, washi above and goldleaf below, so it survives being shrunk to a
favicon. Four other treatments were tried at 240 / 64 / 32 / 16px in
[`variants.html`](variants.html); each one that drew an actual rule across the
drop lost the tip to a floating cone at small sizes.

Nothing here uses a colour, a typeface, or a hairline weight that the app does
not already use. `banner.html` copies its values out of `web/app/globals.css`
verbatim, so the header and the site cannot drift apart.

## Sources

| File | What it is |
| --- | --- |
| [`mark.svg`](mark.svg) | The mark, transparent, with a `prefers-color-scheme` rule — cream on dark, sumi on cream. |
| [`mark-plate.svg`](mark-plate.svg) | The mark on black paper with the site's water tint. The avatar. |
| [`banner.html`](banner.html) | The X header, as a page. Open it in a browser to edit it. |
| [`intro.html`](intro.html) | The introduction cards — the `underwater.fun × InkChain` lockup, at post size (`#post`) and header size (`#header`). |
| [`posts.html`](posts.html) | The three post cards that go with the launch thread, one per fragment: `#curve`, `#graduation`, `#fees`. |
| [`plates.html`](plates.html) | The six standalone posts from `x-growth.md` as cards: `#spec`, `#teaser`, `#question`, `#locked`, `#everyfee`, `#chain`. Typographic rather than diagrammatic — the sentence set large, because these posts win by being legible in a quarter of a second. |
| [`nft.html`](nft.html) | The Underwater Plates sneak peeks: `#collection`, `#dissolve`, `#drown`, `#sealed`, `#provenance`, `#rarity`, plus `#header` at banner size. The one sheet here that carries **art** rather than type — see below. |
| [`specimens/`](specimens) | Three plates rendered straight out of the sealed table, by slot: `0994`, `1067`, `1776`. Produced by `python art/render.py --slot N --out brand/specimens`, not drawn. |
| [`curve-anim.html`](curve-anim.html) | The animated ident — one launch from nothing to graduation. A pure function of `window.frame(t)`; see below. |
| `ink-mark.png` | The official InkChain mark at 512px, the same asset `web/components/ChainIcon.tsx` draws in the network switcher. Kept here because the only other full-resolution copy lives in the gitignored `web/.shots`. |
| [`x-launch.md`](x-launch.md) | The voice, the posts, and the cadence for starting on X. Copy rather than an asset, but it is the thing the images are for. |
| [`x-plates.md`](x-plates.md) | The post copy for the seven `nft.html` cards, in sequence, plus the claims about the reveal that the contract does not support and the copy therefore does not make. |
| [`x-growth.md`](x-growth.md) | Field notes on what the category's posts actually get rewarded for — 21 posts across seven accounts, with the numbers — and which of those mechanics survive our voice rules. |
| [`variants.html`](variants.html) | The comparison sheet that chose the treatment. Kept as the reasoning, not as an asset. |

## Rendered

```bash
node brand/render.mjs
```

Headless Chrome over CDP — the banner is a real page with real web fonts, and
only a browser draws it the way the site does. The shutter waits on
`document.fonts.ready`, so a run can never quietly ship a banner set in Georgia.

| File | Size | Where it goes |
| --- | --- | --- |
| `mark-plate-400.png` | 400×400 | **X profile picture.** X wants ≥400×400 and crops to a circle — nothing is in the corners. |
| `x-intro-1600x900.png` | 1600×900 | **The introduction post.** The `× InkChain` lockup; 16:9 is the one ratio X shows uncropped in a timeline. |
| `x-intro-3200x1800.png` | 3200×1800 | The same card at 2×. Upload this one if X takes it. |
| `x-intro-header-1500x500.png` | 1500×500 | **X header**, the arrival version — matches the introduction post. |
| `x-banner-1500x500.png` | 1500×500 | **X header**, the Fig. 1 version. Nothing important sits in the lower left, where X hangs the avatar. |
| `x-banner-3000x1000.png` | 3000×1000 | The same header at 2×. Upload this one if X will take it: it survives re-encoding better. |
| `x-post-curve.png` | 1600×900 | The pinned post, and post 2/ of the launch thread. |
| `x-post-graduation.png` | 1600×900 | Post 3/ — graduation and the burn address. |
| `x-post-fees.png` | 1600×900 | Post 4/ — the complete fee schedule, all four of them. |
| `x-plate-spec.png` | 1600×900 | The spec chant — `One curve. 4 ETH to graduate. 25×, exactly.` |
| `x-plate-teaser.png` | 1600×900 | The teaser — Fig. 1's axes with Fig. 1's curve taken out. |
| `x-plate-question.png` | 1600×900 | The question, with a ruled blank where the answer would go. |
| `x-plate-locked.png` | 1600×900 | The refusal — three things called locked against one address. |
| `x-plate-everyfee.png` | 1600×900 | Every fee **and its hard cap**. The most trust-buying card here. |
| `x-plate-chain.png` | 1600×900 | The co-brand, written to be quotable by @inkonchain. |
| `x-nft-collection.png` | 1600×900 | **The drop announcement.** Three real plates and the pre-commitment claim. |
| `x-nft-dissolve.png` | 1600×900 | One plate at six health factors. The card that explains what the collection *is*. |
| `x-nft-drown.png` | 1600×900 | `drown(uint256)` — a stranger burns your plate and mints the trophy. Both requires, in check order. |
| `x-nft-sealed.png` | 1600×900 | What a minter actually receives before the reveal, at the renderer's native 400×620. |
| `x-nft-provenance.png` | 1600×900 | The three checkable claims, with the provenance hash. |
| `x-nft-rarity.png` | 1600×900 | Five counted traits out of 2222. Counts, not weights. |
| `x-nft-header-1500x500.png` | 1500×500 | **X header** for the drop — four plates, one per pigment the collection can print. |
| `mark-plate-1024.png` | 1024×1024 | Square icon anywhere else — Discord, a GitHub org, an app store. |
| `mark-1024.png` | 1024×1024 | Transparent mark for dark backgrounds. |
| `mark-light-1024.png` | 1024×1024 | Transparent mark for cream backgrounds. |
| `web/app/icon.svg` | vector | The site favicon. A copy of `mark.svg`, so the theme rule inside it is read by the browser tab. |
| `web/app/apple-icon.png` | 180×180 | iOS home screen. Opaque, because iOS composites it over wallpaper. |

The cards in `intro.html`, `posts.html`, `plates.html` and `nft.html` are selected
by URL fragment and shown with `:target` rather than script, so the shutter never
races a `DOMContentLoaded` handler. Their `<body>` is magenta on purpose: a capture
that misses the card's bounds shows up in the PNG instead of passing as a black
margin.

Two of these cards publish a fee schedule and describe it as complete, which makes
them the only assets here where being wrong is expensive. **The fee list is four
long, not three** — three settable ones in `UnderwaterLaunchpad.sol` plus the DEX's
hardcoded 0.30% swap fee, of which `UnderwaterPair._mintFee` mints the protocol 1/6
of the growth in √k. Count them out of the contracts before either card ships;
`brand/x-growth.md` finding 6 is what happens to a launchpad that gets this wrong
in public.

The InkChain half of the intro lockup is the **official mark**, full-colour, at
512px. It is a raster because the upstream "SVG" is a PNG in a wrapper and a
hand-rebuilt version was measurably wrong — the same reasoning, at length, in
`web/components/ChainIcon.tsx`. It is also the only saturated colour on any card
in this folder, which is deliberate: a logo recoloured to fit our palette stops
being the logo.

## The plates cards

`nft.html` is the only sheet here that publishes the art, and it does it by
pointing `<img>` at real renderer output — the committed states in `art/showcase/`
and three specimens out of the sealed table. Never a mockup: a collection whose
entire pitch is *the table was committed before you bought* cannot advertise itself
with a drawing of what the art might look like. An `<img>` also isolates each
SVG's internal ids, which inlining would not: the renderer namespaces its filters
per plate, and two plates in one document sharing a namespace share one dissolve.

Three rules the obvious version of these cards breaks, all three of them things a
buyer can check:

- **Trait names are the exact strings `UnderwaterNames.sol` emits.** "Satoshi",
  not "Satoshi medallion". "Gold leaf", not "Goldleaf". "Ink · Kraken" is one
  emblem — Kraken, whose chain this is — not a pigment and an emblem. A card that
  says *count them yourself* and then prints a name absent from every trait filter
  has sent the reader somewhere they cannot arrive.
- **The numbers stamped on the previews are table slots, not plate numbers.**
  `render.py` passes `slot + 1`, and on chain the plate→slot mapping is an offset
  `reveal()` draws after minting closes. `#collection` says so in a footnote
  rather than letting the stamped number imply otherwise.
- **"Aberration" is not a rarity tier.** It forces a slot's pigment to goldleaf
  and writes no trait of its own, so nothing in the packed table distinguishes
  one. `#rarity` publishes the 147 goldleaf plates instead, which is countable.
  Slot 1067 — the gold-on-blueprint specimen leading two cards — happens to be one
  of the 22, and is captioned "Gold leaf on blueprint" and nothing else.

Counts come from `traits/traits.json`, the sealed table, and are **counts rather
than the weights** in `art/traits/manifest.json`. Those differ — 2222 draws off a
weight table do not land on the weights.

The copy that goes with these cards, and their posting order, is
[`x-plates.md`](x-plates.md). It ends with a fourth rule that belongs to the text
rather than the cards: **`reveal()` is unpermissioned and its offset is
`blockhash(block.number - 1)`**, so whoever calls it first gets one free roll at an
offset they can compute before they submit. Nothing on a card claims otherwise —
`#sealed` says no *mint* position can be timed, which is true — but a caption or a
reply that widens that into "the reveal cannot be gamed" would be the finding-6
mistake on the one axis this collection sells.

## Motion

```bash
node brand/animate.mjs
```

Five seconds of one launch running from nothing to graduation. `curve-anim.html`
holds no clock — no CSS transitions, no `requestAnimationFrame`, just
`window.frame(t)` for `t` in 0..1 — so the frames come out evenly spaced in *t*
however long each screenshot took. Recording the page as it played would instead
sample whatever the compositor managed under load, and a stutter would be baked
into the file. The curve is the protocol's own formula sampled at render time,
which is why the readout lands on exactly 25 gwei at exactly 4 ETH.

| File | What | Where it goes |
| --- | --- | --- |
| `x-curve.gif` | 50 frames, 10fps, 800px | **The X post.** X transcodes uploaded GIFs to MP4 server-side and autoplays them. Also Discord, Telegram, a README. |
| `x-curve.webp` | 150 frames, 30fps, 1000px | The site — animated WebP, smaller and sharper than the GIF. |
| `x-curve.webm` | VP9, 1200×675 | Any embed that takes a container X will not. |
| `x-curve-poster.png` | 1200×675 | The final frame, for thumbnails and anywhere motion will not play. |

**No MP4, and not for want of trying.** The encoder is Chrome's `MediaRecorder`,
which is what lets this run with no ffmpeg on the machine — but headless Chrome
answers `isTypeSupported("video/mp4;codecs=avc1")` with `true` and then records
zero bytes, because there is no H.264 encoder behind the claim. So `animate.mjs`
tries every container for real and rejects any output under 4KB; the run prints
what it rejected rather than leaving an empty `.mp4` behind. GIF is the postable
motion asset until an ffmpeg exists here.

GIF and WebP need `sharp`, which lives in `web/node_modules` — a script in
`brand/` cannot reach it, because Node resolves from the importing *file* upward.
`animate.mjs` resolves it against the web package explicitly and treats it as
optional.

## Colours

| | Dark | Light |
| --- | --- | --- |
| Ink (`--ink`, washi) | `#e8e2d2` | `#12100e` |
| Goldleaf (`--goldleaf`) | `#c9a24b` | `#7a5a0e` |
| Paper (`--paper`) | `#000000` | `#f4efe2` |

Type: **Fraunces** (display, `SOFT 30 / WONK 1`), **Spectral** (prose),
**JetBrains Mono** (every number).
