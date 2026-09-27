import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ImageStore, sniff } from "../server/images.ts";
import { expectError } from "./support.ts";

/** Smallest byte strings each format's magic check accepts, padded out. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF = new TextEncoder().encode("GIF89a......");
const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const NOW = 1_800_000_000_000;

const dir = mkdtempSync(join(tmpdir(), "uwzec-images-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("formats are identified by their bytes; SVG and HTML never pass", () => {
  assert.equal(sniff(PNG), "png");
  assert.equal(sniff(JPG), "jpg");
  assert.equal(sniff(GIF), "gif");
  assert.equal(sniff(WEBP), "webp");
  assert.equal(sniff(SVG), null);
  assert.equal(sniff(new TextEncoder().encode("<html><script>")), null);
  assert.equal(sniff(new TextEncoder().encode("GIF87")), null, "truncated header");
});

test("images are content-addressed: same bytes, same id, stored once", () => {
  const s = new ImageStore(null);
  const id = s.put("alice", PNG, NOW);
  assert.match(id, /^[0-9a-f]{64}\.png$/);
  assert.equal(s.put("bob", PNG, NOW), id);
  assert.equal(s.usedBytes, PNG.length);
  assert.deepEqual(s.get(id), { bytes: PNG, type: "image/png" });
  assert.equal(s.get("nope"), null);
  assert.equal(s.get("../../etc/passwd"), null, "ids are checked before touching the disk");
  expectError("InvalidArgument", () => s.put("alice", SVG, NOW));
  expectError("InvalidArgument", () => s.put("alice", new Uint8Array(), NOW));
});

test("limits: size per image, uploads per account per day, and a total cap", () => {
  const s = new ImageStore(null, { maxBytes: 64, totalBytes: 40, perAccountPerDay: 2 });
  const big = new Uint8Array(65);
  big.set(PNG);
  expectError("InvalidArgument", () => s.put("alice", big, NOW));

  const png = (n: number) => Uint8Array.from([...PNG, n]);
  s.put("alice", png(1), NOW);
  s.put("alice", png(2), NOW);
  expectError("LimitExceeded", () => s.put("alice", png(3), NOW));
  s.put("alice", png(1), NOW); // a repeat is free
  assert.ok(s.put("alice", png(3), NOW + 86_400_001), "a day later the quota is back");
  expectError("LimitExceeded", () => s.put("bob", png(4), NOW)); // 3 × 13 bytes stored; a 4th passes 40
});

test("on disk: written whole, and counted again after a restart", () => {
  const a = new ImageStore(dir);
  const id = a.put("alice", JPG, NOW);
  writeFileSync(join(dir, "stray.txt"), "not an image");
  assert.deepEqual(readdirSync(dir).sort(), [id, "stray.txt"].sort(), "no .tmp left behind");
  const b = new ImageStore(dir);
  assert.equal(b.usedBytes, JPG.length, "only images count toward the cap");
  assert.deepEqual(Buffer.from(b.get(id)?.bytes ?? []), Buffer.from(JPG));
});
