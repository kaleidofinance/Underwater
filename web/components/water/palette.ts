"use client";

/**
 * The stylesheet, read back out.
 *
 * Every colour and weight the shader needs is already declared in globals.css as
 * a custom property, and several of them differ between the light and dark
 * blocks. Rather than restate any of that in TypeScript — two copies of a
 * palette drift, and the one in the shader would be the copy nobody remembers to
 * update — this reads the computed values off the document. globals.css stays the
 * single source of truth for what the water looks like, the same as it is for the
 * CSS fallback.
 *
 * `getComputedStyle` on a custom property returns it with `var()` already
 * substituted, so `--water-1: var(--sunlit)` arrives here as the hex.
 */

type Rgb = [number, number, number];

const FALLBACK: Rgb = [0, 0, 0];

/** `#rgb`, `#rrggbb`, or the bare `190 226 232` triple `--shaft-rgb` uses. */
function parseColor(raw: string): Rgb {
  const s = raw.trim();
  if (!s) return FALLBACK;

  if (s.startsWith("#")) {
    const h = s.slice(1);
    const wide = h.length >= 6;
    const at = (i: number) =>
      wide
        ? parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255
        : parseInt(h[i]! + h[i]!, 16) / 255;
    const rgb: Rgb = [at(0), at(1), at(2)];
    return rgb.some(Number.isNaN) ? FALLBACK : rgb;
  }

  // `rgb(...)` from a browser that normalised it, or the space-separated triple.
  const parts = s
    .replace(/^rgba?\(/, "")
    .replace(/\)$/, "")
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return FALLBACK;
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255];
}

function num(raw: string, fallback: number): number {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type Palette = {
  paper: [number, number, number, number];
  water1: [number, number, number, number];
  water2: [number, number, number, number];
  water3: [number, number, number, number];
  /** rgb from `--shaft-rgb`, w from `--shaft-alpha`. */
  shaftCol: [number, number, number, number];
};

/**
 * vec4f throughout, including for the three water colours that only need rgb.
 * WGSL aligns a `vec3f` to 16 bytes anyway, so the padding exists either way and
 * declaring it is one less alignment rule to be wrong about later.
 */
export function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const c = (name: string): [number, number, number, number] => {
    const [r, g, b] = parseColor(s.getPropertyValue(name));
    return [r, g, b, 1];
  };
  const shaft = parseColor(s.getPropertyValue("--shaft-rgb"));
  return {
    paper: c("--paper"),
    water1: c("--water-1"),
    water2: c("--water-2"),
    water3: c("--water-3"),
    shaftCol: [
      shaft[0],
      shaft[1],
      shaft[2],
      num(s.getPropertyValue("--shaft-alpha"), 0.24),
    ],
  };
}

/**
 * The two per-page weights, folded to the single number the gradient's opacity
 * is calculated from in CSS.
 *
 * `--t` (curve progress) and `--lev` (a plate's leverage) are set as an inline
 * style on `.shell`, which is a *sibling* of the water layer — so the canvas
 * inherits neither and has to go and look. Cheap because it is read on
 * navigation, not per frame: a `getComputedStyle` in a frame callback would force
 * a style recalculation sixty times a second to learn a number that changes when
 * the route does.
 */
export function readDepth(): { tint: number; shaft: number } {
  const root = getComputedStyle(document.documentElement);
  const shell = document.querySelector(".shell");
  const scoped = shell ? getComputedStyle(shell) : root;

  const pick = (name: string, fallback: number) => {
    const own = scoped.getPropertyValue(name);
    return num(own || root.getPropertyValue(name), fallback);
  };

  const t = pick("--t", 0);
  const lev = pick("--lev", 0.15);
  const depthTint = num(root.getPropertyValue("--depth-tint"), 0.2);

  return {
    // The same expression as `.water::after`'s opacity, kept literally identical
    // so the two layers cannot disagree about how deep a page is.
    tint: depthTint * (1 - (t * 0.62 + lev * 0.38)),
    shaft: num(root.getPropertyValue("--shaft"), 1) * 0.5,
  };
}
