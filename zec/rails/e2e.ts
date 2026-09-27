/**
 * Live round trip on Zcash testnet, for a user whose deposit address has
 * already been funded: credit → launch and trade → mature → withdraw → settle.
 *
 *   node rails/e2e.ts [user] [--log data/testnet.jsonl]
 *
 * The withdrawal goes back to the treasury itself, at an unassigned
 * diversifier index, so the test exercises building, proving, broadcasting
 * and settling a real transaction without giving the coins away. That
 * self-send then shows up exactly as it should: an alert for a payment to
 * an unassigned address, and positive reserve drift equal to its amount.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HashChain, ZEC_LAUNCH_FEES, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { HttpWallet } from "./http-wallet.ts";
import { DEFAULT_POLICY, Rails, type TickReport } from "./rails.ts";
import { readWalletEnv } from "./wallet-env.ts";

const ZATS = 100_000_000n;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const user = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "tester";
const li = process.argv.indexOf("--log");
const logPath = resolve(root, (li >= 0 ? process.argv[li + 1] : undefined) ?? "data/testnet.jsonl");

const store = openEngine(logPath, {
  params: ZEC_PARAMS,
  fees: ZEC_LAUNCH_FEES,
});
const e = store.engine;
const wallet = new HttpWallet(readWalletEnv(root));
const rails = new Rails(e, wallet, DEFAULT_POLICY);

const t0 = Date.now();
const stamp = (): string => `${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 1000)}s`;
const zec = (z: bigint): string => `${(Number(z) / 1e8).toFixed(8)} TAZ`;
const say = (msg: string): void => console.log(`${stamp()}  ${msg}`);

function report(r: TickReport): void {
  const parts = (["credited", "matured", "reversed", "submitted", "rebroadcast", "settled", "failed"] as const)
    .filter((k) => r[k].length > 0)
    .map((k) => `${k} ${r[k].join(",")}`);
  if (parts.length > 0) say(`tip ${r.tip} · ${parts.join(" · ")}`);
  for (const a of r.alerts) say(`alert: ${a}`);
}

async function tickUntil(label: string, done: () => boolean, maxMinutes = 30): Promise<void> {
  say(`waiting: ${label}`);
  const deadline = Date.now() + maxMinutes * 60_000;
  let lastTip = -1;
  for (;;) {
    const r = await rails.tick();
    report(r);
    if (r.tip !== lastTip) {
      lastTip = r.tip;
      process.stdout.write(`${stamp()}  tip ${r.tip}\r`);
    }
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await new Promise((ok) => setTimeout(ok, 20_000));
  }
}

try {
  if (!e.addressOf(user)) throw new Error(`${user} has no deposit address in ${logPath}`);
  say(`round trip for ${user} · log ${logPath} (${store.replayed} commands replayed)`);

  // 1. Credit at 3 confirmations.
  await tickUntil("deposit credited (3 confirmations)", () => e.balance(user) > 0n);
  say(`credited: balance ${zec(e.balance(user))}, withdrawable ${zec(e.withdrawable(user))} (immature)`);

  // 2. Trade immediately, while the deposit is still immature.
  const token = e.create(user, { name: "Testnet Pepe", symbol: "TPEPE", metadataURI: "", value: e.fees.creationFee + 2n * ZATS / 100n }).result.token;
  say(`launched ${token}: ${user} holds ${e.balance(user, token) / 10n ** 18n} tokens, FDV ${zec(e.marketCap(token))}`);
  const bought = e.buy(user, token, ZATS / 100n).result;
  say(`bought ${bought / 10n ** 18n} more for 0.01 TAZ; FDV ${zec(e.marketCap(token))}`);
  const got = e.sell(user, token, e.balance(user, token) / 2n).result;
  say(`sold half back for ${zec(got)}; FDV ${zec(e.marketCap(token))}`);
  say(`balance ${zec(e.balance(user))}, still not withdrawable: ${zec(e.withdrawable(user))}`);

  // 3. Maturity at 10 confirmations.
  await tickUntil("deposit final (10 confirmations)", () => e.withdrawable(user) > 0n);
  say(`final: withdrawable ${zec(e.withdrawable(user))}`);

  // 4. Withdraw to the treasury's own unassigned index 9999.
  const destination = await wallet.addressAt(9_999);
  const amount = 3n * ZATS / 100n;
  const withdrawalId = await rails.requestWithdrawal(user, destination, amount);
  say(`withdrawal ${withdrawalId.slice(0, 8)} requested: ${zec(amount)} → own address #9999`);
  await tickUntil("withdrawal built and broadcast", () => e.withdrawalRecord(withdrawalId)?.state === "submitted", 10);
  const txid = e.withdrawalRecord(withdrawalId)?.txid ?? "";
  say(`broadcast ${txid} · network fee ${zec(e.batch(txid)?.networkFee ?? 0n)}`);

  // 5. Settle at 10 confirmations.
  await tickUntil("withdrawal settled (10 confirmations)", () => e.withdrawalRecord(withdrawalId)?.state === "settled");
  say(`settled ${txid}`);

  // 6. Books.
  const { expected, actual, drift } = await rails.reconcile();
  e.ledger.verify();
  say(`${user}: ${zec(e.balance(user))} + ${e.balance(user, token) / 10n ** 18n} ${token}`);
  say(`reserves: ledger ${zec(expected)} · wallet ${zec(actual)} · drift ${zec(drift)} (the self-sent ${zec(amount)} is back in the wallet, uncredited)`);
  say(`ledger rebuilt from ${e.ledger.journal.length} entries ✓ · command log ${e.chain.length} records, verifies ${HashChain.verify(e.chain.records) ? "✓" : "✗"}`);
} catch (err) {
  say(`FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
