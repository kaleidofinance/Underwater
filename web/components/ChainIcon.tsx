import { anvil, chainById, ink, inkSepolia, robinhood, robinhoodTestnet } from "@/lib/chains";

/**
 * Chain marks.
 *
 * Ink's is the official mark, downscaled to 128px and served from
 * public/chains/ink.png — see .shots/scale.mjs, which regenerates it from
 * inkonchain.com/icon.svg.
 *
 * It is a raster on purpose. The upstream "SVG" is a 512px PNG in an SVG
 * wrapper, so there are no paths to reuse, and a hand-rebuilt version was
 * measurably wrong — 56 of 64 sampled rows disagreed with the original, missing
 * the inset ring entirely. A trademark that is nearly right is worse than a
 * 6 KB image.
 *
 * The brand colours are the one saturated thing on the page. Everything else
 * draws from the palette, but a logo that recolours itself stops being the logo.
 */
const INK_MARK = "/chains/ink.png";

/**
 * Robinhood's, and it goes the opposite way on every count — a vector, and two of
 * them.
 *
 * A vector because here the official file really is one: 779 bytes, a single
 * `<path>`, served from Robinhood's own bucket and declared by the chain's testnet
 * explorer as `NEXT_PUBLIC_NETWORK_ICON`. Both files are byte-identical to what
 * that config points at, deliberately — the mark is checkable against its source
 * rather than merely close to it, which is the whole complaint the Ink note above
 * records.
 *
 * Two of them because **this mark is monochrome by its owner's design, not by our
 * palette's**. The same config ships a black and a white variant and sets
 * `invertIconInDarkMode: true`, so serving black on cream and white on black is
 * following the trademark's own usage rather than recolouring it. There is no
 * saturated version of the chain mark to prefer; the lime square is the brokerage
 * app's icon, a different mark for a different product.
 *
 * Both ship and the sheet hides one, which is the same trick — and the same
 * reason — as `.th-sun` / `.th-moon` in globals.css: the theme follows the OS
 * *and* an explicit override, so React cannot know during the first render which
 * one is right, and a mark picked after mount lands wrong for everyone whose
 * machine disagrees with the default and then corrects itself a frame later. CSS
 * knows at paint time. See the `.mark-on-*` block in globals.css.
 */
const RH_MARK_DARK = "/chains/robinhood-white.svg";
const RH_MARK_LIGHT = "/chains/robinhood.svg";

/**
 * The feather is taller than it is wide — viewBox 115.87 × 149.53, a tight
 * bounding box rather than a padded square like Ink's disc. Squaring it to `size`
 * would stretch it, so the height is the size and the width follows the ratio:
 * the two marks then match by the height of their ink, which is how a pair of
 * logos is matched. (`brand/intro.html` makes the same argument for the drop and
 * the disc, where it has to be done by hand.)
 */
const RH_RATIO = 115.87 / 149.53;

/**
 * A local node has no brand, so it gets furniture instead of a logo: the same
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
  const isInk = chainId === ink.id || chainId === inkSepolia.id;
  const isRobinhood =
    chainId === robinhood.id || chainId === robinhoodTestnet.id;
  const rhWidth = Math.round(size * RH_RATIO);

  return (
    <span className={className} style={{ display: "block", lineHeight: 0 }}>
      {isInk ? (
        // Plain <img>: it is a fixed 15–22px decoration, so next/image's
        // srcset and lazy machinery would cost more than it saves. Marked
        // decorative — the chain's name is right beside it.
        <img src={INK_MARK} alt="" width={size} height={size} aria-hidden="true" />
      ) : isRobinhood ? (
        <>
          <img
            className="mark-on-dark"
            src={RH_MARK_DARK}
            alt=""
            width={rhWidth}
            height={size}
            aria-hidden="true"
          />
          <img
            className="mark-on-light"
            src={RH_MARK_LIGHT}
            alt=""
            width={rhWidth}
            height={size}
            aria-hidden="true"
          />
        </>
      ) : (
        <LocalMark size={size} />
      )}
    </span>
  );
}

/**
 * "mainnet" / "testnet" / "local" — which kind of network this is.
 *
 * Read off the `testnet` flag each chain declares rather than matched against a
 * list of ids, which is the version that cannot drift: the id list said "anything
 * that is not anvil or Ink Sepolia is a mainnet", so adding a testnet meant
 * remembering to come back here, and a switcher row reading "mainnet · chain
 * 46630" is a lie about which network somebody is about to trade on. Anvil is
 * still named outright — it declares `testnet` too, and "local" is the more useful
 * of the two true things.
 */
export function chainKind(chainId: number): string {
  if (chainId === anvil.id) return "local";
  return chainById(chainId)?.testnet ? "testnet" : "mainnet";
}
