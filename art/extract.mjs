#!/usr/bin/env node
/**
 * Lifts the art out of underwater-prototype.html into one file per trait, plus a
 * manifest describing how they compose.
 *
 * Run once (and again whenever the prototype's art changes). After this, the
 * prototype is a preview toy and `art/traits/` is the source of truth — which is
 * the point: production assets should not live inside a 1047-line HTML file, and
 * the Solidity renderer needs them as discrete blobs anyway.
 *
 * It *evaluates* the prototype's own functions rather than re-typing their
 * output, so the files are the exact markup the prototype draws. Re-typing 202
 * paths by hand would introduce drift that nobody would notice until the art
 * looked subtly wrong on chain.
 *
 * Every asset file is a valid standalone SVG you can open and look at. The part
 * the composer uses is delimited by <!--asset--> markers, so extraction needs no
 * XML parser in any language.
 *
 *   node art/extract.mjs
 */

import {mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(HERE, "traits");

// The prototype's art code: from `mulberry32` through the end of `renderPlate`.
// Everything after that line is DOM wiring and would need a browser.
const JS_FIRST_LINE = 293;
const JS_LAST_LINE = 865;

const PLATE_W = 400;
const PLATE_H = 620;

// ─── Evaluate the prototype ───────────────────────────────────────────────

function loadPrototype() {
  const lines = readFileSync(resolve(ROOT, "underwater-prototype.html"), "utf8").split("\n");
  const source = lines.slice(JS_FIRST_LINE - 1, JS_LAST_LINE).join("\n");

  if (!/function mulberry32/.test(source) || !/function renderPlate/.test(source)) {
    throw new Error(
      `lines ${JS_FIRST_LINE}-${JS_LAST_LINE} of the prototype no longer hold the art code — ` +
        "the file was edited and the line numbers above need updating",
    );
  }

  // The slice is deliberately DOM-free, so it runs under plain Node.
  const expose = `return {CAT, INK, PAPER, STATES, DIVER, HEADGEAR, HELD, RELIC, EMBLEM,
    mulberry32, relicLayer, emblemLayer, sceneLayer, tetherPath, faunaLayer, scarLayer,
    substrateLayer, params, stateFor, inkFor};`;

  // eslint-disable-next-line no-new-func
  return new Function(`${source}\n${expose}`)();
}

// ─── Emit ─────────────────────────────────────────────────────────────────

/** A standalone-viewable wrapper. `viewBox` differs per coordinate space: the
 *  diver and scenes are drawn in plate space, everything else in unit space and
 *  scaled up at composition time. */
function wrap(fragment, {viewBox, ink = "#12100E", paper = "#E8E2D2", scale = 1}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  <style>
    .fill{fill:${ink}}
    .st{fill:none;stroke:${ink};stroke-linecap:round;stroke-linejoin:round}
    .paperfill{fill:${paper}}
    .paperst{fill:none;stroke:${paper};stroke-linecap:round}
  </style>
  <rect x="${viewBox.split(" ")[0]}" y="${viewBox.split(" ")[1]}" width="${viewBox.split(" ")[2]}" height="${viewBox.split(" ")[3]}" fill="${paper}"/>
  <g${scale === 1 ? "" : ` transform="scale(${scale})"`}><!--asset-->${fragment}<!--/asset--></g>
</svg>
`;
}

const written = [];

function emit(category, key, fragment, wrapOpts) {
  const dir = resolve(OUT, category);
  mkdirSync(dir, {recursive: true});
  const path = resolve(dir, `${key}.svg`);
  writeFileSync(path, wrap(fragment, wrapOpts));
  written.push({category, key, bytes: fragment.length, empty: fragment.trim() === ""});
}

// Unit-space assets are drawn in roughly -1..1 and blown up by these factors at
// composition time. Previewing them at 1:1 would show a dot, hence `scale`.
const UNIT = (scale) => ({viewBox: "-1.2 -1.2 2.4 2.4", scale: 1, previewScale: scale});
const PLATE = {viewBox: `0 0 ${PLATE_W} ${PLATE_H}`};

try {
  const P = loadPrototype();
  rmSync(OUT, {recursive: true, force: true});

  // Drawn figures, in plate space.
  for (const [key, d] of Object.entries(P.DIVER)) emit("diver", key, d.body, PLATE);

  // Unit-space assets. Previewed inside a -1.2..1.2 box, composed at the scale
  // recorded in the manifest.
  for (const [key, frag] of Object.entries(P.HEADGEAR)) emit("headgear", key, frag, UNIT(42));
  for (const [key, frag] of Object.entries(P.HELD)) emit("held", key, frag, UNIT(44));
  for (const [key, frag] of Object.entries(P.RELIC)) emit("relic", key, frag, UNIT(46));
  for (const [key, frag] of Object.entries(P.EMBLEM)) emit("emblem", key, frag, UNIT(19));

  // Scenes are static plate-space markup.
  for (const key of Object.keys(P.CAT.scene.opts)) emit("scene", key, P.sceneLayer(key), PLATE);

  // Tethers hang off the diver's head. `tetherPath` derives a dozen coordinates
  // from that anchor, so probing at a real head position would bake them in.
  // Probing at the anchor's own origin instead makes every coordinate a pure
  // offset, and the composer just translates the whole group — same geometry, no
  // placeholder substitution to get wrong.
  for (const key of Object.keys(P.CAT.tether.opts)) {
    emit("tether", key, P.tetherPath(key, {x: -32, y: 24}), {viewBox: "-40 -200 200 240"});
  }

  // The chrome around relics and emblems: a specimen card and a chart-office
  // stamp. Kept as files too, so no composer hardcodes them.
  //
  // `relicLayer` also scatters four random encrustation circles right after the
  // relic. Probing with a fixed RNG would freeze one plate's barnacles into the
  // frame and every plate would wear the same ones, so that run is templated out
  // separately and regenerated per plate.
  const relicSample = P.RELIC.quill;
  const relicFull = P.relicLayer("quill", P.mulberry32(1));
  const relicAt = relicFull.indexOf(relicSample);
  if (relicAt < 0) throw new Error("relic frame: sample fragment not found in relicLayer output");
  const relicTail = relicFull.slice(relicAt + relicSample.length);
  const encRun = relicTail.match(/^\s*(?:<circle[^>]*\/>\s*)+/);
  if (!encRun) throw new Error("relic frame: could not locate the encrustation circles");
  emit(
    "_frame",
    "relic",
    `${relicFull.slice(0, relicAt)}{{CONTENT}}{{ENCRUSTATION}}${relicTail.slice(encRun[0].length)}`,
    PLATE,
  );

  const emblemSample = P.EMBLEM.bitcoin;
  const emblemFull = P.emblemLayer("bitcoin");
  if (!emblemFull.includes(emblemSample)) throw new Error("emblem frame: sample fragment not found");
  emit("_frame", "emblem", emblemFull.replace(emblemSample, "{{CONTENT}}"), PLATE);

  // ─── Manifest ───────────────────────────────────────────────────────────

  const manifest = {
    note:
      "Generated by art/extract.mjs from underwater-prototype.html. " +
      "Category and option order is the on-chain wire format: do not reorder.",
    plate: {width: PLATE_W, height: PLATE_H},
    categories: Object.keys(P.CAT).map((k) => ({
      key: k,
      label: P.CAT[k].label,
      shape: P.CAT[k].shape,
      space: ["diver", "scene", "tether"].includes(k) ? "plate" : k === "fauna" ? "procedural" : "unit",
      options: Object.keys(P.CAT[k].opts).map((v, i) => ({
        index: i,
        key: v,
        label: P.CAT[k].opts[v][0],
        weight: P.CAT[k].opts[v][1],
      })),
    })),
    // How a unit-space asset is placed. `diverAnchors` supplies head/hand per
    // diver, because a jellyfish's head is not where a skeleton's is.
    transforms: {
      headgear: {anchor: "head", scale: "head.r"},
      held: {anchor: "hand", scale: 44, rotate: "hand.rot"},
      relic: {translate: [94, 508], scale: 46, frame: "_frame/relic.svg"},
      emblem: {translate: [330, 106], rotate: -7, scale: 19, frame: "_frame/emblem.svg", opacity: 0.55},
      // Extracted at the anchor's origin, so the file is pure offsets.
      tether: {translate: ["head.x + 32", "head.y - 24"]},
    },
    diverAnchors: Object.fromEntries(
      Object.entries(P.DIVER).map(([k, d]) => [k, {head: d.head, hand: d.hand}]),
    ),
    ink: P.INK,
    paper: P.PAPER,
    // Health-factor bands, and the substrate override that keeps blueprint
    // readable (light ink on dark paper).
    states: P.STATES.map((s) => ({key: s.k, name: s.name, min: s.min, depth: s.depth})),
    blueprintInk: "#DCE9EF",
    // params(hf) in the prototype. Ported arithmetic, kept here so the Python
    // and Solidity renderers agree on the dissolve rather than each guessing —
    // art/render.py asserts its own integer constants against these on every run.
    dissolve: {
      tFrom: {ceiling: 2.6, span: 1.6},
      // pow was 1.7 in the prototype. Both renderers use 7/4 so the curve is
      // exact integer arithmetic on chain; see UnderwaterMath.pow74.
      disp: {base: 4, gain: 78, pow: 1.75},
      blur: {base: 0.2, gain: 2.6, pow: 2},
      freq: {base: 0.01, gain: 0.014},
      bleed: {dispMul: 2.4, dispAdd: 22, blurBase: 2, blurGain: 9, opBase: 0.1, opGain: 0.5},
      sat: {base: 1, gain: 0.72},
      op: {base: 1, gain: 0.24},
    },
    procedural: {
      fauna: "RNG-driven; ported in art/render.py",
      scars: "RNG-driven; ported in art/render.py",
      substrate: "ruling and grids are generated; ported in art/render.py",
    },
  };

  mkdirSync(OUT, {recursive: true});
  writeFileSync(resolve(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);

  // ─── Report ─────────────────────────────────────────────────────────────

  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const gold = (s) => `\x1b[33m${s}\x1b[0m`;

  console.log(`\n  ${gold("Underwater")} art extraction\n`);
  const byCat = {};
  for (const w of written) (byCat[w.category] ??= []).push(w);
  let total = 0;
  for (const [category, items] of Object.entries(byCat)) {
    const bytes = items.reduce((n, i) => n + i.bytes, 0);
    total += bytes;
    const empty = items.filter((i) => i.empty).length;
    console.log(
      `  ${category.padEnd(10)} ${String(items.length).padStart(2)} files  ` +
        `${String(bytes).padStart(6)} B${empty ? dim(`  (${empty} intentionally blank)`) : ""}`,
    );
  }
  const drawn = written.filter((w) => !w.empty && w.category !== "_frame").length;
  console.log(`\n  ${drawn} drawn assets, ${total} B of markup`);
  console.log(dim(`  wrote art/traits/**/*.svg + manifest.json\n`));
} catch (err) {
  console.error(`\n  \x1b[31mfailed\x1b[0m ${err?.message ?? err}\n`);
  process.exit(1);
}
