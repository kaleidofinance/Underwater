/**
 * The rails process: the durable engine, the treasury wallet service, and a
 * tick loop moving money between them.
 *
 *   node rails/run.ts [--log data/engine.jsonl] [--interval 15]
 *
 * Needs WALLET_URL and WALLET_API_TOKEN (environment, or zec/.env.wallet).
 * Safe to stop and restart at any point: the log replays and the first tick
 * rescans everything since the wallet's birthday.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZEC_PARAMS, openEngine, type FeeParams } from "../engine/index.ts";
import { HttpWallet } from "./http-wallet.ts";
import { DEFAULT_POLICY, Rails } from "./rails.ts";
import { readWalletEnv } from "./wallet-env.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return (i >= 0 ? process.argv[i + 1] : undefined) ?? fallback;
}

/** Launch fees for a new log. Product values, placeholders until decided. */
const LAUNCH_FEES: FeeParams = {
  tradeFeeBps: 100n, // 1%
  graduationFeeBps: 500n, // 5%
  creationFee: 100_000n, // 0.001 ZEC
};

const logPath = resolve(root, arg("--log", "data/engine.jsonl"));
const intervalMs = Number(arg("--interval", "15")) * 1000;
mkdirSync(dirname(logPath), { recursive: true });

const store = openEngine(logPath, { params: ZEC_PARAMS, fees: LAUNCH_FEES });
const wallet = new HttpWallet(readWalletEnv(root));
const rails = new Rails(store.engine, wallet, DEFAULT_POLICY);

const stamp = (): string => new Date().toISOString().slice(11, 19);
console.log(
  `${stamp()} rails up · log ${logPath} (${store.replayed} commands replayed${store.truncatedTail ? ", torn tail cut" : ""})`,
);

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});

let ticks = 0;
while (!stopping) {
  try {
    const r = await rails.tick();
    const moved = [
      ["credited", r.credited],
      ["matured", r.matured],
      ["reversed", r.reversed],
      ["submitted", r.submitted],
      ["rebroadcast", r.rebroadcast],
      ["settled", r.settled],
      ["failed", r.failed],
    ].filter(([, list]) => (list as string[]).length > 0);
    if (moved.length > 0) {
      console.log(`${stamp()} tip ${r.tip} · ${moved.map(([k, list]) => `${k} ${(list as string[]).join(",")}`).join(" · ")}`);
    }
    for (const alert of r.alerts) console.warn(`${stamp()} ALERT ${alert}`);
    if (ticks++ % 20 === 0) {
      const { expected, actual, drift } = await rails.reconcile();
      const flag = drift < 0n ? " ✗ ZEC MISSING" : drift > 0n ? " (surplus)" : " ✓";
      console.log(`${stamp()} tip ${r.tip} · reserves: ledger ${expected} · wallet ${actual} · drift ${drift}${flag}`);
    }
  } catch (err) {
    console.error(`${stamp()} tick failed: ${(err as Error).message}`);
  }
  await new Promise((done) => setTimeout(done, intervalMs));
}

store.close();
console.log(`${stamp()} rails stopped cleanly`);
