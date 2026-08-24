"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useTokenMeta } from "@/lib/metadata";

/**
 * A token's art, or a mark standing in for the art it does not have.
 *
 * Most launches will never supply an image — the field is a free string on a
 * contract nobody has to fill in — and a list of forty empty squares is worse
 * than no images at all. So the fallback is not a placeholder graphic but a
 * plate generated from the token's own address: same address, same mark,
 * everywhere it appears, which makes it recognisable without pretending to be
 * something the creator chose.
 *
 * A plain `<img>` rather than `next/image`: the source is an arbitrary URL from
 * a token creator, and the optimiser needs every host whitelisted up front.
 */
export function TokenArt({
  token,
  symbol,
  uri,
  size = 30,
}: {
  token: Address;
  symbol: string;
  uri?: string;
  size?: number;
}) {
  const { meta } = useTokenMeta(uri);
  const [broken, setBroken] = useState(false);

  if (meta?.image && !broken)
    return (
      <img
        className="art"
        src={meta.image}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    );

  return <Sigil token={token} symbol={symbol} size={size} />;
}

/**
 * The generated mark: a wash from the palette, two hairline rings and an
 * initial, all placed by bytes of the address.
 *
 * The hues are the fixed ones from the design system rather than a hash spread
 * over the colour wheel — five sea colours the rest of the page already uses, so
 * a list of these still reads as one plate instead of a bag of sweets.
 */
function Sigil({
  token,
  symbol,
  size,
}: {
  token: Address;
  symbol: string;
  size: number;
}) {
  const hex = token.slice(2);
  const byte = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;

  const hue = HUES[byte(0) % HUES.length];
  const initials = symbol.replace(/[^\p{L}\p{N}]/gu, "").slice(0, size >= 64 ? 2 : 1);

  const rings = [0, 1].map((n) => ({
    cx: 8 + (byte(1 + n * 3) / 255) * 24,
    cy: 8 + (byte(2 + n * 3) / 255) * 24,
    r: 6 + (byte(3 + n * 3) / 255) * 13,
  }));

  return (
    <svg
      className="art"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <rect x="0" y="0" width="40" height="40" fill={hue} opacity="0.18" />
      {rings.map((c, i) => (
        <circle
          key={i}
          cx={c.cx.toFixed(1)}
          cy={c.cy.toFixed(1)}
          r={c.r.toFixed(1)}
          fill="none"
          stroke={hue}
          strokeWidth="0.8"
          opacity="0.55"
        />
      ))}
      <text
        x="20"
        y="20.5"
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontFamily: "var(--display)",
          fontVariationSettings: '"SOFT" 40, "WONK" 1',
          fontSize: initials.length > 1 ? 15 : 19,
          fill: "var(--ink)",
          letterSpacing: "-0.02em",
        }}
      >
        {initials || "·"}
      </text>
    </svg>
  );
}

/** The palette's fixed hues — identical in both themes, so safe as literals. */
const HUES = [
  "#2e7a8c", // sunlit
  "#14384a", // twilight
  "#4a7c59", // kelp
  "#c9a24b", // goldleaf
  "#7a2318", // oxblood
] as const;
