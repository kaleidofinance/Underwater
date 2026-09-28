import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ZEC_LAUNCH_FEES, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { generateBackupKey, open, seal } from "../server/backup.ts";
import { ZEC, fund } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "uwzec-backup-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a sealed backup opens with the private key, and only with it", () => {
  const key = generateBackupKey();
  const secret = Buffer.from("the engine log, byte for byte\n");
  const sealed = seal(key.publicKey, secret);
  assert.deepEqual(open(key.privateKey, sealed), secret);
  assert.notDeepEqual(seal(key.publicKey, secret).ct, sealed.ct, "fresh ephemeral key and nonce every time");

  const other = generateBackupKey();
  assert.throws(() => open(other.privateKey, sealed), "another key can't open it");
  const flipped = Buffer.from(sealed.ct, "base64url");
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  assert.throws(() => open(key.privateKey, { ...sealed, ct: flipped.toString("base64url") }), "tampering is detected");
  assert.throws(() => seal("too-short", secret));
});

test("restore opens a real backup, replays its log to the same head, and writes no secrets to stdout", () => {
  const key = generateBackupKey();
  const keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, `private: ${key.privateKey}\npublic:  ${key.publicKey}\n`);

  const logPath = join(dir, "engine.jsonl");
  const a = openEngine(logPath, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  fund(a.engine, "alice", ZEC);
  a.engine.create("alice", { name: "T", symbol: "T", metadataURI: "", value: ZEC / 10n });
  const head = a.engine.chain.head;
  const length = a.engine.chain.length;
  a.close();

  const seedHex = "ab".repeat(32);
  const backup = {
    createdAt: Date.now(),
    api: null,
    log: { length, head, sealed: seal(key.publicKey, readFileSync(logPath)) },
    waitlist: {
      count: 1,
      sealed: seal(key.publicKey, Buffer.from(`${JSON.stringify({ t: "join", account: "a", handle: "fan", email: "fan@example.com", code: "ABCDEF", referredBy: null, at: 1 })}
`)),
    },
    wallet: seal(key.publicKey, Buffer.from(JSON.stringify({ network: "test", seed_hex: seedHex, accounts: [{ name: "treasury", birthday: 1 }], reserve_ufvk: "uview" }))),
  };
  const file = join(dir, "backup.json");
  writeFileSync(file, JSON.stringify(backup));

  const out = join(dir, "restored");
  const stdout = execFileSync(process.execPath, [join(import.meta.dirname, "..", "ops", "restore.ts"), file, keyFile, out], { encoding: "utf8" });
  assert.match(stdout, /engine log: .*✓ matches the backup/);
  assert.match(stdout, /waitlist: 1 sign-ups ✓ matches the backup/);
  assert.ok(!stdout.includes("fan@example.com"), "emails are never printed");
  assert.ok(!stdout.includes(seedHex), "the seed is never printed");
  assert.deepEqual(readdirSync(out).sort(), ["accounts.json", "engine.jsonl", "seed.bin", "waitlist.jsonl"]);
  assert.equal(readFileSync(join(out, "seed.bin")).toString("hex"), seedHex);
});
