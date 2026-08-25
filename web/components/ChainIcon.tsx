import { anvil, ink, inkSepolia } from "@/lib/chains";

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
  return (
    <span className={className} style={{ display: "block", lineHeight: 0 }}>
      {isInk ? (
        // Plain <img>: it is a fixed 15–22px decoration, so next/image's
        // srcset and lazy machinery would cost more than it saves. Marked
        // decorative — the chain's name is right beside it.
        <img src={INK_MARK} alt="" width={size} height={size} aria-hidden="true" />
      ) : (
        <LocalMark size={size} />
      )}
    </span>
  );
}

/** "mainnet" / "testnet" / "local" — which kind of network this is. */
export function chainKind(chainId: number): string {
  if (chainId === anvil.id) return "local";
  return chainId === inkSepolia.id ? "testnet" : "mainnet";
}
