import { networkFor } from "@/lib/chains";

/**
 * Chain marks.
 *
 * Ink's is the official mark, downscaled to 128px and served from
 * public/chains/ink.png — see .shots/scale.mjs, which regenerates it from
 * inkonchain.com/icon.svg. Which network has one is a field on the registry in
 * lib/chains.ts, so a new chain arrives here as artwork or as null and never as a
 * condition to edit.
 *
 * It is a raster on purpose. The upstream "SVG" is a 512px PNG in an SVG
 * wrapper, so there are no paths to reuse, and a hand-rebuilt version was
 * measurably wrong — 56 of 64 sampled rows disagreed with the original, missing
 * the inset ring entirely. A trademark that is nearly right is worse than a
 * 6 KB image.
 *
 * Robinhood's is the opposite case on every count, and this note used to say they
 * had no mark at all. They do. It is not on `chain.robinhood.com`, which does not
 * resolve, and it is not the explorer favicon, which really is a 404 — it is in
 * their own asset bucket, and the way to find it is to read the explorer's
 * Blockscout config rather than to guess at paths: `NEXT_PUBLIC_NETWORK_ICON` and
 * `_ICON_DARK` name the two files outright. 779 bytes each, one `<path>`, an actual
 * vector. Both ship byte-identical, so this mark is checkable against its source
 * instead of merely close to it.
 *
 * **Two files because its owner publishes two, not because we have two themes.**
 * That config also sets `invertIconInDarkMode: true`, so black-on-cream and
 * white-on-black is the trademark's prescribed usage. There is no saturated version
 * of the chain mark to prefer either: the lime square is the brokerage app's icon, a
 * different mark for a different product, and using it here would be the wrong logo
 * rendered correctly.
 *
 * Both variants render and CSS hides one — the same trick, and the same reason, as
 * `.th-sun` / `.th-moon` in globals.css. The theme follows the OS preference *and* an
 * explicit override, so React cannot know during the first render which ground the
 * mark will land on; a variant picked after mount is wrong for everyone whose
 * machine disagrees with the default and then corrects itself a frame later. CSS
 * knows at paint time. See the `.mark-on-*` block in globals.css.
 *
 * The brand colours are the one saturated thing on the page. Everything else
 * draws from the palette, but a logo that recolours itself stops being the logo.
 */

/**
 * A network with no mark of its own gets furniture instead of a logo: the same
 * square-on-square the rest of the interface is built from, in whatever colour
 * it inherits.
 */
function LocalMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="46"
        y="46"
        width="420"
        height="420"
        fill="none"
        stroke="currentColor"
        strokeWidth="52"
      />
      <rect x="196" y="196" width="120" height="120" fill="currentColor" />
    </svg>
  );
}

/** The mark for a chain, or the neutral one for anything unrecognised. */
export function ChainIcon({
  chainId,
  size = 15,
  className,
}: {
  chainId: number;
  size?: number;
  className?: string;
}) {
  const icon = networkFor(chainId)?.icon ?? null;

  // Plain <img> throughout: these are fixed 15–22px decorations, so next/image's
  // srcset and lazy machinery would cost more than it saves. Marked decorative —
  // the chain's name is right beside it.
  //
  // A `ratio` means the artwork is not square, so `size` is its height and the
  // width follows. Rounded because a fractional attribute reserves a fractional
  // box, and a row of marks then sits on fractional pixels for no gain.
  //
  // Both cases are pulled out as their own variable rather than narrowed inside the
  // JSX: `pair === null` tells the compiler nothing about `icon`, so the one-file
  // branch would still be typed `string | ChainMark` and `src` would reject it.
  const pair = typeof icon === "object" && icon !== null ? icon : null;
  const single = typeof icon === "string" ? icon : null;
  const width = pair?.ratio ? Math.round(size * pair.ratio) : size;

  return (
    <span className={className} style={{ display: "block", lineHeight: 0 }}>
      {pair ? (
        <>
          <img
            className="mark-on-dark"
            src={pair.dark}
            alt=""
            width={width}
            height={size}
            aria-hidden="true"
          />
          <img
            className="mark-on-light"
            src={pair.light}
            alt=""
            width={width}
            height={size}
            aria-hidden="true"
          />
        </>
      ) : single ? (
        <img src={single} alt="" width={size} height={size} aria-hidden="true" />
      ) : (
        <LocalMark size={size} />
      )}
    </span>
  );
}

/**
 * "mainnet" / "testnet" / "local" — which kind of network this is.
 *
 * Read off the registry rather than derived from the id, which is the whole reason
 * the registry exists: this used to be "anvil is local, Ink Sepolia is testnet,
 * anything else is mainnet", and the first testnet added after that would have been
 * labelled a mainnet on the switcher with nothing failing to say so.
 */
export function chainKind(chainId: number): string {
  return networkFor(chainId)?.kind ?? "unknown";
}
