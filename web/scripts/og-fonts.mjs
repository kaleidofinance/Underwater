#!/usr/bin/env node
/**
 * Vendor the latin subsets of the three brand faces for the OG card renderer.
 *
 *   node scripts/og-fonts.mjs
 *
 * Why vendor rather than fetch at render time. Satori — the renderer behind
 * `next/og` — has no system font to fall back on: hand it no font data and it
 * throws rather than substituting something. So the font *is* a hard dependency
 * of every share card, and a card that 500s because fonts.gstatic.com was slow
 * is worse than no card at all, because the crawler caches the failure. Files on
 * disk turn a network dependency at request time into one at `npm run` time,
 * which is the only place it belongs.
 *
 * Why the ancient User-Agent. Google Fonts content-negotiates on it: a modern
 * browser string gets woff2, which Satori cannot parse, and a 2015 Chrome gets
 * woff, which it can. This is the same trick every @vercel/og example uses.
 *
 * Why parse the comments. The css2 endpoint ignores `&subset=latin` and returns
 * every subset it has — cyrillic, vietnamese, latin-ext, latin — each as its own
 * @font-face with a `unicode-range`. The only thing that reliably names a block
 * is the CSS comment Google emits above it, so that is what is matched. Taking
 * the wrong block yields a font with no ASCII in it, which renders as a card of
 * blank boxes.
 *
 * Fraunces is requested twice, at two points in its variation space, because the
 * wordmark uses two: `under`/`.fun` at SOFT 30 and `water` at SOFT 80. Satori
 * ignores `font-variation-settings`, so the axes have to be baked in at the
 * source and registered as two separate families. Asking Google for a named
 * instance is what bakes them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** A 2015 Chrome, so the css2 endpoint serves woff instead of woff2. */
const LEGACY_UA =
  "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.2214.85 Safari/537.36";

/**
 * `public/`, not next to the routes that use them, because Cloudflare Workers has
 * no deployed filesystem to read from — see the note on `FONT_DIR` in lib/og.tsx.
 */
const OUT = resolve("public", "og", "fonts");

/**
 * `file` is what lib/og.tsx loads; `query` is the css2 `family=` value verbatim.
 * The two Fraunces entries are the wordmark's two variation instances — see the
 * header. `opsz` is set per instance because Fraunces' optical size axis changes
 * the stroke contrast, and the display sizes on a 1200×630 card want the high
 * end of it.
 */
const FACES = [
  {
    file: "fraunces-soft30.woff",
    query: "Fraunces:opsz,wght,SOFT,WONK@120,400,30,1",
    note: "display — under / .fun",
  },
  {
    file: "fraunces-soft80.woff",
    query: "Fraunces:opsz,wght,SOFT,WONK@144,300,80,1",
    note: "display — water, the goldleaf syllable",
  },
  {
    file: "spectral-300.woff",
    query: "Spectral:wght@300",
    note: "prose",
  },
  {
    file: "jetbrains-mono-400.woff",
    query: "JetBrains+Mono:wght@400",
    note: "numbers",
  },
  {
    file: "jetbrains-mono-500.woff",
    query: "JetBrains+Mono:wght@500",
    note: "numbers, emphasised",
  },
];

/**
 * The url() from the @font-face block whose preceding comment names `subset`.
 *
 * Deliberately not a single greedy regex over the whole sheet: the blocks are
 * uniform enough that splitting on the comment is both shorter and impossible to
 * get subtly wrong, which a regex spanning two blocks would be.
 */
function urlForSubset(css, subset) {
  for (const chunk of css.split("/*").slice(1)) {
    const [label, body] = [chunk.slice(0, chunk.indexOf("*/")), chunk];
    if (label.trim() !== subset) continue;
    const m = body.match(/url\((https:\/\/[^)]+)\)/);
    if (m) return m[1];
  }
  return null;
}

/** Does this actually begin like a font, or did we save an error page? */
function sniff(buf) {
  const tag = buf.subarray(0, 4).toString("latin1");
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2"; // parseable by nothing here — reject
  if (tag === "OTTO" || tag === "true" || tag === "ttcf") return "otf/ttf";
  if (buf.readUInt32BE(0) === 0x00010000) return "ttf";
  return null;
}

mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const face of FACES) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${face.query}&display=swap`;

  const cssRes = await fetch(cssUrl, {
    headers: { "User-Agent": LEGACY_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!cssRes.ok) {
    console.error(`✗ ${face.file}: css ${cssRes.status}`);
    failed++;
    continue;
  }

  const url = urlForSubset(await cssRes.text(), "latin");
  if (!url) {
    console.error(`✗ ${face.file}: no latin block in the sheet`);
    failed++;
    continue;
  }

  const fontRes = await fetch(url, {
    headers: { "User-Agent": LEGACY_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!fontRes.ok) {
    console.error(`✗ ${face.file}: font ${fontRes.status}`);
    failed++;
    continue;
  }

  const buf = Buffer.from(await fontRes.arrayBuffer());
  const kind = sniff(buf);
  if (kind !== "woff" && kind !== "ttf" && kind !== "otf/ttf") {
    console.error(`✗ ${face.file}: not a parseable font (sniffed ${kind ?? "garbage"})`);
    failed++;
    continue;
  }

  writeFileSync(resolve(OUT, face.file), buf);
  console.log(
    `✓ ${face.file.padEnd(26)} ${String(Math.round(buf.length / 1024)).padStart(4)} KB  ${kind}  — ${face.note}`,
  );
}

if (failed) {
  console.error(`\n${failed} face(s) failed. The OG routes cannot render without them.`);
  process.exit(1);
}
console.log(`\nwrote ${FACES.length} faces to ${OUT}`);
