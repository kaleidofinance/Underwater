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
| `x-banner-1500x500.png` | 1500×500 | **X header.** Nothing important sits in the lower left, where X hangs the avatar. |
| `x-banner-3000x1000.png` | 3000×1000 | The same header at 2×. Upload this one if X will take it: it survives re-encoding better. |
| `mark-plate-1024.png` | 1024×1024 | Square icon anywhere else — Discord, a GitHub org, an app store. |
| `mark-1024.png` | 1024×1024 | Transparent mark for dark backgrounds. |
| `mark-light-1024.png` | 1024×1024 | Transparent mark for cream backgrounds. |
| `web/app/icon.svg` | vector | The site favicon. A copy of `mark.svg`, so the theme rule inside it is read by the browser tab. |
| `web/app/apple-icon.png` | 180×180 | iOS home screen. Opaque, because iOS composites it over wallpaper. |

## Colours

| | Dark | Light |
| --- | --- | --- |
| Ink (`--ink`, washi) | `#e8e2d2` | `#12100e` |
| Goldleaf (`--goldleaf`) | `#c9a24b` | `#7a5a0e` |
| Paper (`--paper`) | `#000000` | `#f4efe2` |

Type: **Fraunces** (display, `SOFT 30 / WONK 1`), **Spectral** (prose),
**JetBrains Mono** (every number).
