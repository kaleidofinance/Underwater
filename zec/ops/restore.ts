/**
 * Open a backup and prove it restores.
 *
 *   node ops/restore.ts <backup.json> <private-key-file> <out-dir>
 *
 * Decrypts the engine log and the wallet seed into <out-dir>, replays the log
 * end to end (every hash checked), and checks the seed belongs to this
 * platform by comparing the reserve viewing key it carried with the live one.
 * Prints no secrets.
 *
 * To actually restore: put engine.jsonl on the API's volume as
 * /data/engine.jsonl, and seed.bin on the wallet's volume as /data/seed.bin
 * (the wallet rescans the chain from the account birthdays in accounts.json),
 * and waitlist.jsonl next to the engine log.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZEC_LAUNCH_FEES, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { open, type Sealed } from "../server/backup.ts";
import { Waitlist } from "../server/waitlist.ts";

const [file, keyFile, out] = process.argv.slice(2);
if (!file || !keyFile || !out) throw new Error("usage: node ops/restore.ts <backup.json> <private-key-file> <out-dir>");
const privateKey = /^private:\s*(\S+)$/m.exec(readFileSync(keyFile, "utf8"))?.[1] ?? readFileSync(keyFile, "utf8").trim();
const backup = JSON.parse(readFileSync(file, "utf8")) as {
  createdAt: number;
  api: string | null;
  log: { length: number; head: string; sealed: Sealed };
  wallet: Sealed | null;
  /** Absent in backups from before the waitlist was included. */
  waitlist?: { count: number; sealed: Sealed };
};

mkdirSync(out, { recursive: true });
const logPath = join(out, "engine.jsonl");
writeFileSync(logPath, open(privateKey, backup.log.sealed), { flag: "wx" });
const store = openEngine(logPath, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
const ok = store.engine.chain.length === backup.log.length && store.engine.chain.head === backup.log.head;
console.log(`engine log: ${store.engine.chain.length} commands replayed, head ${store.engine.chain.head.slice(0, 16)} ${ok ? "✓ matches the backup" : "✗ MISMATCH"}`);
store.close();
if (!ok) process.exit(1);

if (backup.waitlist) {
  const path = join(out, "waitlist.jsonl");
  writeFileSync(path, open(privateKey, backup.waitlist.sealed), { flag: "wx" });
  const count = new Waitlist(path).size;
  console.log(`waitlist: ${count} sign-ups ${count === backup.waitlist.count ? "✓ matches the backup" : "✗ MISMATCH"}`);
  if (count !== backup.waitlist.count) process.exit(1);
}

if (backup.wallet) {
  const wallet = JSON.parse(open(privateKey, backup.wallet).toString("utf8")) as {
    network: string;
    seed_hex: string;
    accounts: Array<{ name: string; birthday: number }>;
    reserve_ufvk: string;
  };
  const seed = Buffer.from(wallet.seed_hex, "hex");
  if (seed.length !== 32) throw new Error("the sealed seed isn't 32 bytes");
  writeFileSync(join(out, "seed.bin"), seed, { flag: "wx" });
  writeFileSync(join(out, "accounts.json"), JSON.stringify({ network: wallet.network, accounts: wallet.accounts }, null, 2), { flag: "wx" });
  let check = "(no API to compare against)";
  if (backup.api) {
    const live = (await (await fetch(`${backup.api}/api/audit`)).json()) as { reserve: { ufvk: string } };
    check = live.reserve.ufvk === wallet.reserve_ufvk ? "✓ its reserve key matches the live platform" : "✗ MISMATCH with the live reserve key";
  }
  console.log(`wallet seed: 32 bytes, ${wallet.network}net, accounts ${wallet.accounts.map((a) => `${a.name}@${a.birthday}`).join(", ")} ${check}`);
}
