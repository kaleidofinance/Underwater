/**
 * Print a user's deposit address, assigning one through the durable engine
 * the first time. Same path the web app will use.
 *
 *   node rails/address.ts <user> [--log data/engine.jsonl]
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZEC_LAUNCH_FEES, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { HttpWallet } from "./http-wallet.ts";
import { DEFAULT_POLICY, Rails } from "./rails.ts";
import { readWalletEnv } from "./wallet-env.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const user = process.argv[2];
if (!user || user.startsWith("--")) {
  console.error("usage: node rails/address.ts <user> [--log data/engine.jsonl]");
  process.exit(2);
}
const i = process.argv.indexOf("--log");
const logPath = resolve(root, (i >= 0 ? process.argv[i + 1] : undefined) ?? "data/engine.jsonl");
mkdirSync(dirname(logPath), { recursive: true });

const { url, token } = readWalletEnv(root);
const store = openEngine(logPath, {
  params: ZEC_PARAMS,
  fees: ZEC_LAUNCH_FEES,
});
try {
  const rails = new Rails(store.engine, new HttpWallet({ url, token }), DEFAULT_POLICY);
  const address = await rails.depositAddress(user);
  const index = store.engine.addressOf(user)?.index;
  console.log(`${user} (index ${index}): ${address}`);
} finally {
  store.close();
}
