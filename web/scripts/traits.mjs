#!/usr/bin/env node
/**
 * Generates the committed trait table for the Underwater plates, and the
 * provenance hash the collection is deployed with.
 *
 * This is the one artefact that cannot be produced after launch. The collection
 * takes `provenance` as a constructor argument and `seal()` refuses to open
 * minting unless what is written to storage hashes to it, so the table this
 * script emits is the entire rarity distribution, fixed before anybody has paid
 * anything. Run it once, publish the hash, keep the output.
 *
 * The trait catalogue, the RNG and the aberration set are ported verbatim from
 * underwater-prototype.html, so the table committed on chain is the same
 * collection the prototype renders rather than a second, different one that
 * happens to use the same category names.
 *
 * Deterministic: mulberry32 is int32 arithmetic through Math.imul, and its only
 * float step divides by 2^32, which is exact. Re-running this on any Node build
 * reproduces the same table and therefore the same hash — which is what lets
 * anyone else check our published provenance instead of trusting it.
 *
 *   node scripts/traits.mjs
 *
 * Writes traits/table.csv (PLATES_TABLE), traits/traits.json (the readable
 * collection, for a renderer or a rarity page) and traits/provenance.txt.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, keccak256 } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const OUT = resolve(ROOT, "traits");

// Must match UnderwaterPlates exactly. Asserted below rather than trusted.
const SUPPLY = 2222;
const CATEGORIES = 10;
const TRAIT_BITS = 4;
const BITS_PER_PLATE = 40;
const PLATES_PER_WORD = 6;
const TABLE_WORDS = 371;

/** 22 plates forced to gold leaf. Drawn before the uniqueness check, as in the
 *  prototype, because forcing a pigment afterwards would change the key.
 *
 *  Note this flag does NOT reach the chain. A packed plate is exactly 10
 *  categories x 4 bits = 40 bits with no spare field, so on chain these 22 are
 *  indistinguishable from the 125 plates that roll gold leaf naturally at
 *  weight 6 — 147 in total.
 *
 *  That is the intended distribution: gold leaf is a 6.6% pigment, not a 1%
 *  tier. Decided, and now permanent — the alternative was weight 6 -> 0 here
 *  plus a regenerate, and that had to happen before the provenance hash was
 *  published. The flag stays because the off-chain catalogue in traits.json
 *  still records which 22 the prototype meant. */
const ABERRATIONS = 22;
const ABERRATION_SEED = 0xabe2a71;

// ─── Trait catalogue (ported from underwater-prototype.html) ──────────────
//
// Key order is the wire format: category 0 is the first key here, option 0 the
// first key of its `opts`. Reordering either silently reassigns every plate's
// art, so this block is append-only once the table is published.

const CAT = {
  diver: {
    label: "Diver",
    shape: true,
    opts: {
      human: ["Diver", 26],
      skeleton: ["Skeleton", 20],
      cephalopod: ["Cephalopod", 16],
      jellyfish: ["Jellyfish", 14],
      angler: ["Anglerfish", 14],
      drone: ["Salvage drone", 10],
    },
  },
  headgear: {
    label: "Headgear",
    shape: true,
    opts: {
      brass: ["Brass hardhat", 26],
      scubaMask: ["Scuba mask", 24],
      sphere: ["Pressure sphere", 14],
      bare: ["Bare", 22],
      salvageRig: ["Salvage rig", 14],
    },
  },
  held: {
    label: "Held",
    shape: true,
    opts: {
      harpoon: ["Harpoon", 20],
      lantern: ["Lantern", 20],
      salvageBag: ["Salvage bag", 16],
      diveSlate: ["Dive slate", 14],
      cutHose: ["Cut hose", 12],
      empty: ["Empty hands", 18],
    },
  },
  relic: {
    label: "Relic",
    shape: true,
    opts: {
      none: ["None", 22],
      quill: ["Quill", 10],
      tulip: ["Tulip", 9],
      hourglass: ["Hourglass", 9],
      ingots: ["Ingots", 8],
      tentacle: ["Ink sac", 8],
      frog: ["Pepe", 7],
      shiba: ["Doge", 7],
      magnifier: ["ZachXBT", 6],
      visor: ["Saylor", 6],
      skullCoin: ["Dead coin", 5],
      coin: ["Barnacled coin", 4],
      crystal: ["Cut crystal", 4],
      unicorn: ["Unicorn figurehead", 3],
      medallion: ["Satoshi", 2],
    },
  },
  emblem: {
    label: "Emblem",
    shape: true,
    opts: {
      none: ["Unstamped", 40],
      bitcoin: ["Bitcoin", 14],
      ethereum: ["Ethereum", 12],
      kraken: ["Ink · Kraken", 10],
      robinhood: ["Robinhood", 9],
      uniswap: ["Uniswap", 8],
      opensea: ["OpenSea", 7],
      binance: ["Binance", 6],
    },
  },
  scene: {
    label: "Scene",
    shape: true,
    opts: {
      openWater: ["Open water", 32],
      wreck: ["Wreck", 20],
      kelp: ["Kelp", 18],
      vent: ["Thermal vent", 16],
      chainCurtain: ["Chain curtain", 14],
    },
  },
  tether: {
    label: "Tether",
    shape: true,
    opts: {
      intact: ["Intact rope", 34],
      frayed: ["Frayed", 28],
      severed: ["Severed", 20],
      chain: ["Anchor chain", 18],
    },
  },
  fauna: {
    label: "Fauna",
    shape: false,
    opts: {
      shoal: ["Shoal", 28],
      predator: ["Lone predator", 20],
      motes: ["Motes", 28],
      none: ["Nothing", 24],
    },
  },
  pigment: {
    label: "Pigment",
    shape: false,
    opts: {
      sumi: ["Sumi black", 34],
      sepia: ["Sepia", 24],
      indigo: ["Indigo", 22],
      oxblood: ["Oxblood", 14],
      goldleaf: ["Gold leaf", 6],
    },
  },
  substrate: {
    label: "Substrate",
    shape: false,
    opts: {
      washi: ["Washi", 36],
      vellum: ["Vellum", 28],
      ledger: ["Ledger paper", 22],
      blueprint: ["Blueprint", 14],
    },
  },
};

const KEYS = Object.keys(CAT);
const SHAPE_KEYS = KEYS.filter((k) => CAT[k].shape);
const optionsOf = (k) => Object.keys(CAT[k].opts);
const weightsOf = (k) => Object.entries(CAT[k].opts).map(([v, d]) => [v, d[1]]);
const labelOf = (k, v) => CAT[k].opts[v][0];

// ─── RNG (ported verbatim) ────────────────────────────────────────────────

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted(r, pairs) {
  const tot = pairs.reduce((s, p) => s + p[1], 0);
  let x = r() * tot;
  for (const [v, w] of pairs) {
    if ((x -= w) <= 0) return v;
  }
  return pairs[0][0];
}

// ─── Generate ─────────────────────────────────────────────────────────────

/**
 * Rejection-sampled for global uniqueness. Uniqueness is exactly why the table
 * has to be committed rather than derived from `tokenId` on chain: rejection
 * makes plate n's traits depend on every plate before it, which is not something
 * a view function can recompute cheaply.
 *
 * Note the numbering here is *table order*, not final plate numbers. `reveal()`
 * rotates plate ids onto these slots afterwards, so slot 0 is not plate 1.
 */
function generate() {
  const seen = new Set();
  const list = [];

  const aberrant = new Set();
  const ar = mulberry32(ABERRATION_SEED);
  while (aberrant.size < ABERRATIONS) aberrant.add(1 + Math.floor(ar() * SUPPLY));

  let attempts = 0;
  let rejected = 0;

  while (list.length < SUPPLY) {
    attempts++;
    const n = list.length + 1;
    const r = mulberry32((n * 2654435761) ^ ((attempts * 40503) >>> 0));
    r();
    r();

    const traits = {};
    for (const k of KEYS) traits[k] = weighted(r, weightsOf(k));
    if (aberrant.has(n)) traits.pigment = "goldleaf";

    const key = KEYS.map((k) => traits[k]).join("|");
    if (seen.has(key)) {
      rejected++;
      continue;
    }
    seen.add(key);

    list.push({slot: list.length, traits, aberration: aberrant.has(n)});
  }

  return {list, rejected, attempts};
}

// ─── Pack ─────────────────────────────────────────────────────────────────

/** Indices in category order, which is what the 4-bit fields hold. */
function indicesOf(plate) {
  return KEYS.map((k) => {
    const i = optionsOf(k).indexOf(plate.traits[k]);
    if (i < 0) throw new Error(`slot ${plate.slot}: unknown ${k} "${plate.traits[k]}"`);
    if (i >= 1 << TRAIT_BITS) throw new Error(`${k} option ${i} does not fit in ${TRAIT_BITS} bits`);
    return i;
  });
}

function pack(list) {
  const words = new Array(TABLE_WORDS).fill(0n);

  for (const plate of list) {
    let packed = 0n;
    indicesOf(plate).forEach((index, category) => {
      packed |= BigInt(index) << BigInt(category * TRAIT_BITS);
    });

    const word = Math.floor(plate.slot / PLATES_PER_WORD);
    words[word] |= packed << BigInt((plate.slot % PLATES_PER_WORD) * BITS_PER_PLATE);
  }

  return words;
}

/** The read `traitsOf` performs, so the table is checked by unpacking it rather
 *  than by re-running the packer and agreeing with itself. */
function unpack(words, slot) {
  const word = words[Math.floor(slot / PLATES_PER_WORD)];
  const plate = (word >> BigInt((slot % PLATES_PER_WORD) * BITS_PER_PLATE)) & ((1n << BigInt(BITS_PER_PLATE)) - 1n);

  const out = [];
  for (let c = 0; c < CATEGORIES; c++) {
    out.push(Number((plate >> BigInt(c * TRAIT_BITS)) & ((1n << BigInt(TRAIT_BITS)) - 1n)));
  }
  return out;
}

// ─── Verify ───────────────────────────────────────────────────────────────

function verify(list, words) {
  if (list.length !== SUPPLY) throw new Error(`generated ${list.length}, want ${SUPPLY}`);
  if (words.length !== TABLE_WORDS) throw new Error(`${words.length} words, want ${TABLE_WORDS}`);

  const combos = new Set(list.map((p) => KEYS.map((k) => p.traits[k]).join("|")));
  if (combos.size !== SUPPLY) throw new Error(`${SUPPLY - combos.size} duplicate trait sets`);

  // Every plate survives the round trip through the packed layout. A silent
  // collision here would mint two plates sharing one 40-bit field.
  for (const plate of list) {
    const want = indicesOf(plate);
    const got = unpack(words, plate.slot);
    for (let c = 0; c < CATEGORIES; c++) {
      if (want[c] !== got[c]) {
        throw new Error(`slot ${plate.slot} category ${c}: packed ${got[c]}, want ${want[c]}`);
      }
    }
  }

  // Nothing above the 2222nd plate's field, or `seal` commits to bits the
  // renderer will never be asked about but the hash still covers.
  const tail = words[TABLE_WORDS - 1] >> BigInt((SUPPLY % PLATES_PER_WORD) * BITS_PER_PLATE);
  if (SUPPLY % PLATES_PER_WORD !== 0 && tail !== 0n) throw new Error("garbage past the last plate");

  const goldleaf = list.filter((p) => p.traits.pigment === "goldleaf").length;
  if (goldleaf < ABERRATIONS) throw new Error(`${goldleaf} gold leaf, want at least ${ABERRATIONS}`);
}

// ─── Census ───────────────────────────────────────────────────────────────

/** Printed because the distribution is about to become permanent, and an
 *  operator should get one look at it before it does. */
function census(list) {
  const incidence = {};
  for (const k of KEYS) {
    incidence[k] = {};
    for (const v of optionsOf(k)) incidence[k][v] = 0;
  }

  const silhouettes = new Map();
  for (const p of list) {
    for (const k of KEYS) incidence[k][p.traits[k]]++;
    const s = SHAPE_KEYS.map((k) => p.traits[k]).join("|");
    silhouettes.set(s, (silhouettes.get(s) ?? 0) + 1);
  }

  // Rarity = product of each trait's incidence. Lower is rarer.
  for (const p of list) {
    p.score = KEYS.reduce((acc, k) => acc * (incidence[k][p.traits[k]] / SUPPLY), 1);
  }
  [...list]
    .sort((a, b) => a.score - b.score)
    .forEach((p, i) => {
      p.rank = i + 1;
    });

  return {
    incidence,
    silhouettes: silhouettes.size,
    maxShared: Math.max(...silhouettes.values()),
    space: KEYS.reduce((n, k) => n * optionsOf(k).length, 1),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

try {
  const {list, rejected, attempts} = generate();
  const words = pack(list);
  verify(list, words);
  const stats = census(list);

  // Exactly what `seal()` recomputes: keccak256(abi.encode(uint256[371])).
  // Built with the ABI coder rather than by hand, because the offset and length
  // prefixes a dynamic array carries are the easy thing to get wrong, and the
  // cost of getting it wrong is a mismatch discovered after the commits are paid.
  const encoded = encodeAbiParameters([{type: "uint256[]"}], [words]);
  const provenance = keccak256(encoded);

  mkdirSync(OUT, {recursive: true});
  writeFileSync(resolve(OUT, "table.csv"), words.map(String).join(","));
  writeFileSync(resolve(OUT, "provenance.txt"), `${provenance}\n`);
  writeFileSync(
    resolve(OUT, "traits.json"),
    `${JSON.stringify(
      {
        supply: SUPPLY,
        provenance,
        categories: KEYS.map((k) => ({
          key: k,
          label: CAT[k].label,
          shape: CAT[k].shape,
          options: optionsOf(k).map((v, i) => ({index: i, key: v, label: labelOf(k, v)})),
        })),
        note: "slot is table order, not the final plate number - reveal() rotates ids onto slots",
        plates: list.map((p) => ({
          slot: p.slot,
          rank: p.rank,
          aberration: p.aberration,
          traits: p.traits,
          indices: indicesOf(p),
        })),
      },
      null,
      1,
    )}\n`,
  );

  console.log(`\n  ${gold("Underwater")} trait table\n`);
  console.log(`  plates          ${SUPPLY}, all trait sets unique`);
  console.log(`  combination sp. ${stats.space.toLocaleString()} possible`);
  console.log(`  rejected        ${rejected} duplicate draws over ${attempts} attempts`);
  console.log(`  silhouettes     ${stats.silhouettes} distinct, most shared by ${stats.maxShared}`);
  console.log(`  gold leaf       ${list.filter((p) => p.traits.pigment === "goldleaf").length}`);
  console.log(`  table           ${TABLE_WORDS} words\n`);

  for (const k of KEYS) {
    const parts = optionsOf(k).map((v) => `${labelOf(k, v)} ${dim(stats.incidence[k][v])}`);
    console.log(`  ${CAT[k].label.padEnd(10)} ${parts.join(dim(" · "))}`);
  }

  console.log(`\n  ${green("provenance")}  ${provenance}`);
  console.log(dim("\n  wrote traits/table.csv, traits/traits.json, traits/provenance.txt"));
  console.log(dim("\n  Deploy with this hash, then seal with that table:"));
  console.log(dim(`    PLATES_PROVENANCE=${provenance}`));
  console.log(dim("    PLATES_TABLE=$(cat traits/table.csv)\n"));
} catch (err) {
  console.error(`\n  ${red("failed")} ${err?.message ?? err}\n`);
  process.exit(1);
}
