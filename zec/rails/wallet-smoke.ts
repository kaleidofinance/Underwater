/**
 * Smoke test against the deployed wallet service: read-only, sends nothing.
 *
 *   node rails/wallet-smoke.ts
 *
 * Reads WALLET_URL and WALLET_API_TOKEN from the environment, falling back to
 * zec/.env.wallet (gitignored). Prints no secrets.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpWallet } from "./http-wallet.ts";
import { Lightwalletd } from "./lightwalletd.ts";
import { readWalletEnv } from "./wallet-env.ts";

const { url, token } = readWalletEnv(join(dirname(fileURLToPath(import.meta.url)), ".."));
const wallet = new HttpWallet({ url, token });
const lwd = new Lightwalletd();
let failures = 0;
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

try {
  const health = (await (await fetch(`${url.replace(/\/+$/, "")}/health`)).json()) as { network: string; scanned: number };
  const chainTip = (await lwd.latestBlock()).height;
  const scanned = await wallet.tip();
  console.log(`wallet ${url}`);
  check(health.network === "test", `network is testnet (${health.network})`);
  check(chainTip - scanned <= 10, `scanned to ${scanned}, chain tip ${chainTip} (lag ${chainTip - scanned})`);

  const a0 = await wallet.addressAt(0);
  const a1 = await wallet.addressAt(1);
  check(a0.startsWith("utest1") && a0 !== a1, `distinct Orchard deposit addresses: ${a0.slice(0, 20)}…, ${a1.slice(0, 20)}…`);
  check((await wallet.addressAt(0)) === a0, "address derivation is stable");
  check(await wallet.validateAddress(a1), "validates its own address");
  check(!(await wallet.validateAddress("t1notatestnetaddress")), "rejects a malformed address");

  const notes = await wallet.incoming(Math.max(0, scanned - 1000));
  check(Array.isArray(notes), `incoming notes in the last 1000 blocks: ${notes.length}`);
  console.log(`  spendable: ${await wallet.spendable()} zats`);

  let rejected = false;
  try {
    await new HttpWallet({ url, token: "x".repeat(64) }).tip();
  } catch (err) {
    rejected = /401/.test((err as Error).message);
  }
  check(rejected, "a wrong token is refused");
} catch (err) {
  console.error(`  ✗ ${(err as Error).message}`);
  failures++;
} finally {
  lwd.close();
}
process.exit(failures > 0 ? 1 : 0);
