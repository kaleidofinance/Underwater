/**
 * Parity runner: proves the engine is the same function as the contracts.
 *
 *   1. Generate N random scenarios into parity/fixtures/.
 *   2. Replay them against the real launchpad and DEX in Foundry
 *      (test/zec/ZecParity.t.sol), which records full state after every op.
 *   3. Replay the same scenarios through the engine and require every
 *      recorded number (balances, reserves, supply, outcome codes) to match.
 *
 * Usage:  node parity/run.ts [--count 24] [--ops 160] [--seed N] [--compare-only]
 * Exit code is non-zero on any mismatch or Foundry failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenId } from "../engine/index.ts";
import { generateScenario } from "./gen.ts";
import {
  applyOp,
  decodeScenario,
  describeOp,
  encodeScenario,
  newEngine,
  stateLabels,
  stateVector,
  type Scenario,
} from "./ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const repoRoot = resolve(here, "..", "..");

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const raw = i >= 0 ? process.argv[i + 1] : undefined;
  return raw === undefined ? fallback : Number(raw);
}

const count = arg("--count", 24);
const opCount = arg("--ops", 160);
const seed0 = arg("--seed", Math.floor(Math.random() * 1e9));
const compareOnly = process.argv.includes("--compare-only");

// ─── 1. Generate ────────────────────────────────────────────────────────────

if (!compareOnly) {
  mkdirSync(fixtures, { recursive: true });
  for (const f of readdirSync(fixtures)) {
    if (/^(scenario|trace)-\d+\.jsonl?$/.test(f)) rmSync(join(fixtures, f));
  }
  for (let i = 0; i < count; i++) {
    writeFileSync(join(fixtures, `scenario-${i}.json`), encodeScenario(generateScenario(seed0 + i, opCount)));
  }
  console.log(`generated ${count} scenarios × ${opCount} ops (seeds ${seed0}..${seed0 + count - 1})`);

  // ─── 2. Replay against the contracts ────────────────────────────────────

  const forge = forgeBinary();
  const started = Date.now();
  // Building a JSON state line per op is gas-heavy, and the whole run is one
  // test, so forge's default ~1.07B test gas limit caps it at roughly 1,200
  // ops. Lift it for this run only; the repo's config is untouched.
  const run = spawnSync(forge, ["test", "--match-path", "test/zec/ZecParity.t.sol", "--gas-limit", "9223372036854775807", "-vv"], {
    cwd: repoRoot,
    env: { ...process.env, ZEC_PARITY: "true", ZEC_PARITY_COUNT: String(count) },
    stdio: "inherit",
  });
  if (run.error) {
    console.error(`could not start forge (${forge}): ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.error("forge test failed; no comparison possible");
    process.exit(1);
  }
  console.log(`contracts replayed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// ─── 3. Compare ─────────────────────────────────────────────────────────────

let mismatched = 0;
let totalOps = 0;
let graduations = 0;
const outcomes = new Map<string, number>();

for (let i = 0; i < count; i++) {
  const scenarioPath = join(fixtures, `scenario-${i}.json`);
  const tracePath = join(fixtures, `trace-${i}.jsonl`);
  if (!existsSync(tracePath)) {
    console.error(`scenario ${i}: no trace written by the contracts`);
    mismatched++;
    continue;
  }
  const scenario = decodeScenario(readFileSync(scenarioPath, "utf8"));
  const trace = readFileSync(tracePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);

  const problem = compareScenario(scenario, trace);
  totalOps += scenario.ops.length;
  if (problem) {
    mismatched++;
    console.error(`\n✗ scenario ${i} (seed ${scenario.seed}): ${problem}`);
  }
}

const summary = [...outcomes.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k} ${n}`)
  .join(", ");
console.log(`\noutcomes exercised: ${summary}`);
console.log(`graduations exercised: ${graduations}`);

if (mismatched > 0) {
  console.error(`\nPARITY FAILED: ${mismatched}/${count} scenarios diverged from the contracts`);
  process.exit(1);
}
console.log(`\nPARITY OK: ${count} scenarios, ${totalOps} ops, every state value identical to the contracts`);

// ─── helpers ────────────────────────────────────────────────────────────────

function compareScenario(scenario: Scenario, trace: string[][]): string | null {
  if (trace.length !== scenario.ops.length) {
    return `contracts recorded ${trace.length} ops, scenario has ${scenario.ops.length}`;
  }
  const engine = newEngine(scenario);
  const tokens: TokenId[] = [];
  for (const [j, op] of scenario.ops.entries()) {
    const code = applyOp(engine, tokens, op);
    const ours = stateVector(engine, tokens, scenario.users, code);
    const theirs = trace[j] ?? [];
    const outcome = theirs[0] === "0" ? "ok" : `err${theirs[0]}`;
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);

    if (theirs[0] === "99") return `op ${j} ${describeOp(op)}: contracts reverted with an unmapped error`;
    if (ours.length !== theirs.length) {
      return `op ${j} ${describeOp(op)}: state has ${ours.length} values, contracts have ${theirs.length}`;
    }
    const labels = stateLabels(tokens.length, scenario.users);
    for (let k = 0; k < ours.length; k++) {
      if (ours[k] !== theirs[k]) {
        return `op ${j} ${describeOp(op)}: ${labels[k]} engine=${ours[k]} contracts=${theirs[k]}`;
      }
    }
  }
  graduations += tokens.filter((t) => engine.pool(t)?.graduated).length;
  return null;
}

function forgeBinary(): string {
  const exe = process.platform === "win32" ? "forge.exe" : "forge";
  const local = join(homedir(), ".foundry", "bin", exe);
  return existsSync(local) ? local : exe;
}
