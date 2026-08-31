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
 * That is also why the Robinhood networks have no mark: nothing under
 * `chain.robinhood.com` serves an icon and their explorer's favicon is a 404, so
 * there is no official asset to downscale — and the alternative is drawing a listed
 * company's trademark by hand, which the paragraph above already rejects. They get
 * the neutral square until there is a real file to use.
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
  return (
    <span className={className} style={{ display: "block", lineHeight: 0 }}>
      {icon ? (
        // Plain <img>: it is a fixed 15–22px decoration, so next/image's
        // srcset and lazy machinery would cost more than it saves. Marked
        // decorative — the chain's name is right beside it.
        <img src={icon} alt="" width={size} height={size} aria-hidden="true" />
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
