import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactElement } from "react";

/**
 * The share card's visual language: the same depth scene, mark and wordmark as
 * the app, rebuilt in the CSS subset that `next/og` can actually render.
 *
 * Why rebuilt rather than reused. The cards are drawn by Satori, which lays out
 * with Yoga and paints with resvg — a real renderer, but a small one. It has no
 * cascade and no custom properties, so `var(--goldleaf)` means nothing to it;
 * flexbox is the only layout mode; and three of the things that make the app's
 * water look like water are simply absent: `filter: blur()`, `mix-blend-mode`
 * and `mask-image`. So this file is not a port of globals.css. It is the same
 * design stated a second time under harsher constraints, and every number in the
 * palette below is copied from that sheet's `:root` rather than re-eyeballed, so
 * the two cannot drift apart on colour even where they must differ on technique.
 *
 * Where a constraint bit, the workaround is noted at the point it applies.
 */

/**
 * 1200×630 — the `summary_large_image` aspect. X, Discord, Telegram and Slack
 * all crop toward the centre at slightly different ratios, so nothing that has
 * to survive lives within 40px of an edge.
 */
export const CARD = { width: 1200, height: 630 } as const;

/**
 * How long a card may be reused, as an HTTP header.
 *
 * A header rather than `export const revalidate`. That export is what the docs
 * point you at, and on a route with a dynamic segment in Next 15 it does nothing
 * at all: the route cannot be prerendered without `generateStaticParams`, and
 * token addresses are unbounded, so it stays dynamic and re-renders on every
 * single request. Measured: 2–5s per hit, on every hit, with no `x-nextjs-cache`
 * header to show for it.
 *
 * `s-maxage` is the one that matters — it puts the PNG in Vercel's CDN, so the
 * first crawler pays for the chain reads and the resvg encode and every crawler
 * after it is served bytes. `stale-while-revalidate` covers the day after that:
 * a link doing the rounds is answered instantly from a slightly old card while a
 * fresh one is built behind it, which is the right trade for an image nobody
 * trades off.
 *
 * @param seconds how long the card is considered fresh.
 */
export const cardCache = (seconds: number) =>
  `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=86400`;

/**
 * The palette, verbatim from the `:root` block in app/globals.css. Fixed hues
 * only — the cards have no light theme, because a share card is composited onto
 * whatever the client's timeline is and cannot ask the reader's preference.
 */
export const PALETTE = {
  paper: "#000000",
  sunlit: "#2e7a8c",
  twilight: "#14384a",
  midnight: "#121214",
  washi: "#e8e2d2",
  goldleaf: "#c9a24b",
  oxblood: "#7a2318",
  kelp: "#4a7c59",
} as const;

/** `--ink-rgb` at an alpha — the source of --hair, --ink-dim and --ink-faint. */
export const ink = (alpha: number) => `rgba(232, 226, 210, ${alpha})`;
/** `--shaft-rgb` at an alpha. Sunlight, and everything drawn in its colour. */
export const shaft = (alpha: number) => `rgba(190, 226, 232, ${alpha})`;

/** The roles globals.css derives from --ink-rgb, at the same alphas. */
export const HAIR = ink(0.14);
export const HAIR_2 = ink(0.07);
export const DIM = ink(0.52);
export const FAINT = ink(0.3);

export const FONT = {
  display: "Fraunces",
  /** The wordmark's second variation instance — see scripts/og-fonts.mjs. */
  displaySoft: "Fraunces Soft",
  serif: "Spectral",
  mono: "JetBrains Mono",
} as const;

type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: 300 | 400 | 500;
  style: "normal";
};

const FACES: ReadonlyArray<{ file: string; name: string; weight: 300 | 400 | 500 }> = [
  { file: "fraunces-soft30.woff", name: FONT.display, weight: 400 },
  { file: "fraunces-soft80.woff", name: FONT.displaySoft, weight: 400 },
  { file: "spectral-300.woff", name: FONT.serif, weight: 300 },
  { file: "jetbrains-mono-400.woff", name: FONT.mono, weight: 400 },
  { file: "jetbrains-mono-500.woff", name: FONT.mono, weight: 500 },
];

/**
 * The five vendored faces, read once per process.
 *
 * Memoised on the promise rather than the result so that two cards rendered
 * concurrently in one lambda share a single set of reads instead of racing. The
 * files are checked in — see scripts/og-fonts.mjs for why they are not fetched
 * at request time — and `outputFileTracingIncludes` in next.config.ts is what
 * gets them into the deployed function.
 */
let fontsOnce: Promise<LoadedFont[]> | null = null;

export function brandFonts(): Promise<LoadedFont[]> {
  fontsOnce ??= Promise.all(
    FACES.map(async ({ file, name, weight }) => {
      const buf = await readFile(join(process.cwd(), "app", "og", "fonts", file));
      // Copied into a standalone ArrayBuffer: Node hands back a Buffer that is a
      // view into a shared pool, and satori reads `byteLength` off the buffer
      // rather than the view — so passing `buf.buffer` straight through can hand
      // it a megabyte of unrelated heap and fail to parse.
      return {
        name,
        data: buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer,
        weight,
        style: "normal" as const,
      };
    }),
  );
  return fontsOnce;
}

/* ─── The mark ───────────────────────────────────────────────────────────────
   A drop of ink, half submerged: washi above the waterline, goldleaf below, and
   the waterline itself drawn as a change of tone rather than a rule — see
   brand/README.md for the four treatments that lost the drop at favicon size.

   The two halves are cut by `viewBox` rather than by `clipPath`, which is the one
   real difference from brand/mark.svg. Two SVGs sharing one path, each with a
   viewBox that shows only its own band, is pure geometry — no clipping feature
   for a small renderer to not support. The bands are 0–35 and 35–64 of the 64
   unit square, the same coordinates the clip rects use there.
   ────────────────────────────────────────────────────────────────────────── */

const DROP =
  "M31.4 7 C 33.6 14.2 38.8 20.4 42.2 26.6 C 45 31.6 46 35.2 46 38.4 " +
  "A 14 14 0 0 1 18 38.4 C 18 35 19.1 31.4 22 26.4 C 25.4 20.2 29.6 14 31.4 7 Z";

const SURFACE = 35;
const UNIT = 64;

export function Mark({ size }: { size: number }): ReactElement {
  const air = (size * SURFACE) / UNIT;
  const sea = (size * (UNIT - SURFACE)) / UNIT;
  return (
    <div style={{ display: "flex", flexDirection: "column", width: size, height: size }}>
      <svg width={size} height={air} viewBox={`0 0 ${UNIT} ${SURFACE}`}>
        <path d={DROP} fill={PALETTE.washi} />
      </svg>
      <svg width={size} height={sea} viewBox={`0 ${SURFACE} ${UNIT} ${UNIT - SURFACE}`}>
        <path d={DROP} fill={PALETTE.goldleaf} />
      </svg>
    </div>
  );
}

/**
 * The wordmark, in its two variation instances.
 *
 * `font-variation-settings` is not in Satori's vocabulary, so the SOFT 30 / SOFT
 * 80 split that gives `water` its softer, wetter bowls cannot be asked for here.
 * It is baked into two font files instead and selected by family name — which is
 * why FONT.displaySoft exists and why og-fonts.mjs downloads Fraunces twice.
 */
export function Wordmark({ size }: { size: number }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        fontSize: size,
        // 0.84 and -0.028em in globals.css, resolved against this size because
        // Satori takes lineHeight as a multiplier but letterSpacing in px only.
        lineHeight: 0.84,
        letterSpacing: size * -0.028,
        color: PALETTE.washi,
      }}
    >
      <span style={{ fontFamily: FONT.display }}>under</span>
      <span style={{ fontFamily: FONT.displaySoft, color: PALETTE.goldleaf }}>water</span>
      <span style={{ fontFamily: FONT.display }}>.fun</span>
    </div>
  );
}

/* ─── Token art ──────────────────────────────────────────────────────────────
   The creator's image if there is one, and otherwise the same generated plate
   the app draws — see components/TokenArt.tsx for why the fallback is derived
   from the address rather than being a placeholder graphic.

   The arithmetic below is copied from that component byte for byte, including
   which address bytes feed which ring and the 0.18 wash, because the promise it
   makes is "same address, same mark, everywhere it appears". A card that drew a
   *nearly* identical sigil would break that promise in the one place a reader
   sees the two side by side — the card in their timeline and the page it opens.

   What differs is only technique: the initials are a flex-centred text node
   rather than an SVG `<text>`, since Satori's support for text inside SVG is
   thin, and the wash is a computed rgba rather than a `<rect>` with an opacity.
   ────────────────────────────────────────────────────────────────────────── */

/** The palette's fixed hues, in the order components/TokenArt.tsx indexes them. */
const HUES = ["#2e7a8c", "#14384a", "#4a7c59", "#c9a24b", "#7a2318"] as const;

const rgba = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

export function TokenPlate({
  token,
  symbol,
  art,
  size,
}: {
  token: string;
  symbol: string;
  art: string | null;
  size: number;
}): ReactElement {
  const frame = {
    display: "flex" as const,
    width: size,
    height: size,
    border: `1px solid ${HAIR}`,
  };

  if (art) {
    return (
      <div style={frame}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={art} width={size} height={size} alt="" style={{ objectFit: "cover" }} />
      </div>
    );
  }

  const hex = token.slice(2);
  const byte = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  const hue = HUES[byte(0) % HUES.length];
  const initials = symbol.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "·";
  const rings = [0, 1].map((n) => ({
    cx: 8 + (byte(1 + n * 3) / 255) * 24,
    cy: 8 + (byte(2 + n * 3) / 255) * 24,
    r: 6 + (byte(3 + n * 3) / 255) * 13,
  }));

  return (
    <div
      style={{
        ...frame,
        position: "relative",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: rgba(hue, 0.18),
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        style={{ position: "absolute", left: 0, top: 0 }}
      >
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
      </svg>
      <span
        style={{
          fontFamily: FONT.display,
          // 15/40 and 19/40 of the viewBox in TokenArt.tsx, as a fraction here.
          fontSize: size * (initials.length > 1 ? 0.375 : 0.475),
          letterSpacing: size * -0.02,
          color: PALETTE.washi,
        }}
      >
        {initials}
      </span>
    </div>
  );
}

/**
 * The depth bar: a curve's progress toward graduation, in the sunlit→goldleaf
 * gradient `.depth i` uses. 3px on the page, thicker here — a card is read at
 * thumbnail size in a timeline and a 3px rule disappears at that scale.
 */
export function Depth({ progress }: { progress: number }): ReactElement {
  const pct = Math.min(100, Math.max(0, progress / 100));
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: 7,
        backgroundColor: HAIR_2,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          backgroundImage: `linear-gradient(90deg, ${PALETTE.sunlit}, ${PALETTE.goldleaf})`,
        }}
      />
    </div>
  );
}

/** `.badge` / `.badge.grad` — a hairline chip, gold when it has graduated. */
export function Badge({ children, gold }: { children: string; gold?: boolean }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        fontFamily: FONT.mono,
        fontWeight: 500,
        fontSize: 15,
        letterSpacing: 2.4,
        padding: "7px 13px 8px",
        border: `1px solid ${gold ? PALETTE.goldleaf : HAIR}`,
        color: gold ? PALETTE.goldleaf : DIM,
      }}
    >
      {children.toUpperCase()}
    </div>
  );
}

/* ─── The scene ───────────────────────────────────────────────────────────────
   Paper, the depth wash, four shafts of light, and the plate frame around all of
   it. `t` is what it is everywhere else in this codebase: a curve's progress
   toward graduation, 0..1. The water thins as it rises, so a card for a brand
   new launch is deep and dim and a card for one about to graduate is nearly bare
   paper — the same sentence the token page tells, told in a still image.
   ────────────────────────────────────────────────────────────────────────── */

/** Each shaft's angle, position and width, from the nth-child rules in globals.css. */
const SHAFTS = [
  { left: "6%", rot: 7, sx: 0.7 },
  { left: "29%", rot: -5, sx: 1.15 },
  { left: "57%", rot: 9, sx: 0.55 },
  { left: "79%", rot: -8, sx: 0.9 },
] as const;

/** How far the plate frame sits in from the card's edge. */
const FRAME = 26;

function Shafts(): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        position: "absolute",
        top: 0,
        left: 0,
        width: CARD.width,
        height: CARD.height,
        overflow: "hidden",
      }}
    >
      {SHAFTS.map(({ left, rot, sx }, i) => {
        const w = CARD.width * 0.12 * sx;
        return (
          // Two columns per shaft, not one, because `filter: blur(7px)` is what
          // softens these in the browser and Satori has no filters at all. A
          // single hard-edged column at this alpha reads as a printed triangle;
          // a wide faint one with a narrow brighter one inside it reads as a
          // beam, which is all the blur was ever doing here.
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "center",
              position: "absolute",
              left,
              top: CARD.height * -0.18,
              width: w,
              height: CARD.height * 1.23,
              transform: `rotate(${rot}deg)`,
              backgroundImage: `linear-gradient(180deg, ${shaft(0.055)}, ${shaft(0)} 72%)`,
            }}
          >
            <div
              style={{
                width: w * 0.45,
                height: "100%",
                backgroundImage: `linear-gradient(180deg, ${shaft(0.075)}, ${shaft(0)} 68%)`,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function Scene({
  t = 0.1,
  children,
}: {
  t?: number;
  children: ReactElement | ReactElement[];
}): ReactElement {
  const depth = Math.min(1, Math.max(0, t));
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: CARD.width,
        height: CARD.height,
        backgroundColor: PALETTE.paper,
      }}
    >
      {/* The depth wash: the same four stops and the same
          `--depth-tint * (1 - t * 0.62)` opacity as `.water::after`, with the
          plate term dropped because a token card is not a plate. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: CARD.width,
          height: CARD.height,
          opacity: 0.2 * (1 - depth * 0.62),
          backgroundImage: `linear-gradient(180deg, ${PALETTE.sunlit} 0%, ${PALETTE.twilight} 26%, ${PALETTE.midnight} 52%, rgba(0,0,0,0) 80%)`,
        }}
      />

      <Shafts />

      {/* The plate frame, and the corner ticks that make it read as a plate
          rather than as a border. Each tick is two edges of an otherwise
          borderless box, which cannot fall out of square the way four separate
          rules could.

          Written as `borderTopWidth` and friends rather than as `borderTop: 1`.
          A browser reads that shorthand as a width-only border and draws it;
          Satori's parser wants a full `1px solid <color>` and drops what it
          cannot read, which loses the ticks silently. Long-hand is unambiguous
          to both. */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          top: FRAME,
          left: FRAME,
          width: CARD.width - FRAME * 2,
          height: CARD.height - FRAME * 2,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: HAIR,
        }}
      >
        {[
          { top: -1, left: -1, borderTopWidth: 1, borderLeftWidth: 1 },
          { top: -1, right: -1, borderTopWidth: 1, borderRightWidth: 1 },
          { bottom: -1, left: -1, borderBottomWidth: 1, borderLeftWidth: 1 },
          { bottom: -1, right: -1, borderBottomWidth: 1, borderRightWidth: 1 },
        ].map((corner, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              width: 15,
              height: 15,
              borderStyle: "solid",
              borderColor: ink(0.42),
              borderWidth: 0,
              ...corner,
            }}
          />
        ))}
      </div>

      {/* Content sits inside the frame, with its own gutter off it. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          top: FRAME,
          left: FRAME,
          width: CARD.width - FRAME * 2,
          height: CARD.height - FRAME * 2,
          paddingTop: 34,
          paddingBottom: 34,
          paddingLeft: 40,
          paddingRight: 40,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The strip along the top of every card: the mark, the site, and one fact on the
 * right — the chain on a token card, the register on the site card.
 */
export function Rubric({ right }: { right?: string }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Mark size={26} />
        <span
          style={{
            fontFamily: FONT.mono,
            fontWeight: 500,
            fontSize: 15,
            letterSpacing: 3.4,
            color: DIM,
          }}
        >
          UNDERWATER.FUN
        </span>
      </div>
      {right ? (
        <span
          style={{
            fontFamily: FONT.mono,
            fontWeight: 400,
            fontSize: 14,
            letterSpacing: 2.4,
            color: FAINT,
          }}
        >
          {right.toUpperCase()}
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

/**
 * One cell of the data strip along the bottom: a mono label over a mono value.
 * The whole point of the plate register is that the numbers are the content, so
 * they are set in the same face and the same column widths as on the site.
 */
export function Datum({
  label,
  value,
  gold,
}: {
  label: string;
  value: string;
  gold?: boolean;
}): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <span
        style={{
          fontFamily: FONT.mono,
          fontWeight: 400,
          fontSize: 12,
          letterSpacing: 2,
          color: FAINT,
        }}
      >
        {label.toUpperCase()}
      </span>
      <span
        style={{
          fontFamily: FONT.mono,
          fontWeight: 500,
          fontSize: 22,
          color: gold ? PALETTE.goldleaf : PALETTE.washi,
        }}
      >
        {value}
      </span>
    </div>
  );
}
