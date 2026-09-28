/**
 * Pull an encrypted backup from the API and keep it.
 *
 *   node ops/backup.ts <out-dir> [--api https://...] [--keep 30]
 *
 * Needs ADMIN_TOKEN (read from zec/.env.admin if not in the environment).
 * What it saves is sealed to the backup public key: this script can't read
 * it, and neither can anyone who takes the file. Run it daily; it keeps the
 * newest `--keep` backups and deletes older ones.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const out = process.argv[2];
if (!out || out.startsWith("--")) throw new Error("usage: node ops/backup.ts <out-dir> [--api URL] [--keep N]");
const api = arg("--api", process.env.ZEC_API ?? "https://zec-api-production.up.railway.app").replace(/\/+$/, "");
const keep = Number(arg("--keep", "30"));

let token = process.env.ADMIN_TOKEN;
if (!token) {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.admin");
  if (existsSync(file)) token = /^ADMIN_TOKEN=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
}
if (!token) throw new Error("ADMIN_TOKEN is not set (nor in zec/.env.admin)");

const res = await fetch(`${api}/api/admin/backup`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`backup request failed: ${res.status} ${await res.text()}`);
const backup = (await res.json()) as { createdAt: number; log: { length: number; head: string }; wallet: unknown };
if (!backup.wallet) throw new Error("the backup has no wallet seed: is BACKUP_PUBLIC_KEY set on the wallet service?");

mkdirSync(out, { recursive: true });
const name = `uwzec-backup-${new Date(backup.createdAt).toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(join(out, name), JSON.stringify(backup));
console.log(`saved ${name}: log ${backup.log.length} commands, head ${backup.log.head.slice(0, 16)}, wallet seed sealed`);

const all = readdirSync(out).filter((f) => /^uwzec-backup-.*\.json$/.test(f)).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) {
  rmSync(join(out, old));
  console.log(`removed old ${old}`);
}
