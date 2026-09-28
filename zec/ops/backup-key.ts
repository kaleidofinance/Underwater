/**
 * Make the backup key pair, once.
 *
 *   node ops/backup-key.ts <private-key-file>
 *
 * Writes the private key to the file you name (refusing to overwrite) and
 * prints only the public key. Set that as BACKUP_PUBLIC_KEY on both Railway
 * services. Keep the private key offline: it's the only thing that can open
 * a backup, and a backup is only as good as your copy of it.
 */
import { existsSync, writeFileSync } from "node:fs";
import { generateBackupKey } from "../server/backup.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: node ops/backup-key.ts <private-key-file>");
if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a backup key`);
const { publicKey, privateKey } = generateBackupKey();
writeFileSync(
  out,
  [
    "UNDERWATER.FUN — BACKUP PRIVATE KEY",
    `Created: ${new Date().toISOString()}`,
    "",
    "This opens the platform's encrypted backups (the engine log and the hot",
    "wallet's seed). Without it, no backup can ever be restored. Anyone with",
    "it AND a backup file can read the hot wallet's seed. Keep it offline.",
    "",
    `private: ${privateKey}`,
    `public:  ${publicKey}`,
    "",
  ].join("\r\n"),
  { flag: "wx" },
);
console.log(`private key written to ${out}`);
console.log(`BACKUP_PUBLIC_KEY=${publicKey}`);
