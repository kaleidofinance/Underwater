import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Engine, ZEC_LAUNCH_FEES, ZEC_PARAMS } from "../engine/index.ts";
import { DEFAULT_POLICY, Rails } from "../rails/rails.ts";
import { SimChain } from "../rails/sim.ts";
import { App } from "../server/app.ts";
import { accountId, signingPayload } from "../server/auth.ts";
import { Market } from "../server/market.ts";
import { JOIN_POINTS, REFERRAL_POINTS, type Task, Waitlist } from "../server/waitlist.ts";
import { expectError } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "uwzec-wait-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let t = 1_800_000_000_000;
const join_ = (w: Waitlist, account: string, handle: string, extra: { ref?: string; email?: string; client?: string } = {}) =>
  w.join({ account, handle, email: extra.email, ref: extra.ref ?? null, client: extra.client ?? account, now: (t += 1000) });

test("joining: one spot per account, handles and emails unique, re-joining only updates the email", () => {
  const w = new Waitlist(null);
  const a = join_(w, "acct-a", "@Alice_1", { email: "Alice@Example.com" });
  assert.equal(a.handle, "Alice_1");
  assert.equal(a.points, JOIN_POINTS);
  assert.match(a.code, /^[A-Z2-9]{6}$/);
  assert.equal(join_(w, "acct-a", "whatever").code, a.code, "the same account gets its spot back");
  expectError("DuplicateId", () => join_(w, "acct-b", "alice_1"));
  expectError("DuplicateId", () => join_(w, "acct-b", "bob", { email: "alice@example.com" }));
  expectError("InvalidArgument", () => join_(w, "acct-b", "not a handle"));
  expectError("InvalidArgument", () => join_(w, "acct-b", "bob", { email: "nope" }));
  join_(w, "acct-a", "x", { email: "new@example.com" });
  assert.equal(w.export()[0]?.email, "new@example.com");
});

test("tasks: points once each, only for people on the list, survive a restart, and a retired task stops counting", () => {
  const file = join(dir, "tasks.jsonl");
  const follow: Task = { id: "follow-x", label: "Follow", url: "https://x.com/intent/follow?screen_name=underwaterxyz", points: 25 };
  const like: Task = { id: "like-launch", label: "Like", url: "https://x.com/intent/like?tweet_id=1", points: 10 };
  const w = new Waitlist(file, [follow, like]);
  join_(w, "a", "alice");
  expectError("InvalidState", () => w.completeTask("nobody", "follow-x", t));
  expectError("UnknownId", () => w.completeTask("a", "made-up", t));
  assert.equal(w.completeTask("a", "follow-x", t).points, JOIN_POINTS + 25);
  assert.equal(w.completeTask("a", "follow-x", t).points, JOIN_POINTS + 25, "doing it twice pays once");
  const both = w.completeTask("a", "like-launch", t);
  assert.equal(both.points, JOIN_POINTS + 35);
  assert.deepEqual(both.tasks, ["follow-x", "like-launch"]);

  assert.equal(new Waitlist(file, [follow, like]).standingOf("a")?.points, JOIN_POINTS + 35, "replayed from the file");
  const retired = new Waitlist(file, [follow]).standingOf("a");
  assert.equal(retired?.points, JOIN_POINTS + 25);
  assert.deepEqual(retired?.tasks, ["follow-x"]);
});

test("referrals: 50 points each, never for yourself, and the ranking follows points then join order", () => {
  const w = new Waitlist(null);
  const a = join_(w, "a", "alice");
  const b = join_(w, "b", "bob");
  join_(w, "c", "carol", { ref: a.code.toLowerCase() });
  join_(w, "d", "dave", { ref: a.code });
  join_(w, "e", "erin", { ref: "NOPE42" });
  assert.equal(w.standing(a.code)?.points, JOIN_POINTS + 2 * REFERRAL_POINTS);
  assert.equal(w.standing(a.code)?.referrals, 2);
  assert.equal(w.standing(a.code)?.rank, 1);
  assert.equal(w.standing(b.code)?.rank, 2, "ties go to whoever joined first");
  assert.deepEqual(w.top(2).map((s) => s.handle), ["alice", "bob"]);
});

test("at most 3 sign-ups per network per day", () => {
  const w = new Waitlist(null);
  for (let i = 0; i < 3; i++) join_(w, `x${i}`, `h${i}`, { client: "1.2.3.4" });
  expectError("LimitExceeded", () => join_(w, "x3", "h3", { client: "1.2.3.4" }));
  t += 86_400_001;
  assert.ok(join_(w, "x3", "h3", { client: "1.2.3.4" }));
});

test("the list survives a restart, even with a torn last line", async () => {
  const file = join(dir, "waitlist.jsonl");
  const w = new Waitlist(file);
  const a = join_(w, "a", "alice", { email: "a@example.com" });
  join_(w, "b", "bob", { ref: a.code });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(file, '{"t":"join","acc');
  const again = new Waitlist(file);
  assert.equal(again.size, 2);
  assert.equal(again.standing(a.code)?.points, JOIN_POINTS + REFERRAL_POINTS);
});

test("the API: public list and cards, signed joins, the operator export with emails", async () => {
  let now = 1_800_000_000_000;
  const engine = new Engine({ params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  const token = "t".repeat(40);
  const app = new App({ engine, rails: new Rails(engine, new SimChain(), DEFAULT_POLICY), market: new Market(), adminToken: token, now: () => now });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const call = (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String((now += 1000));
    const sig = sign(null, Buffer.from(signingPayload(method, path, ts, raw)), privateKey).toString("base64url");
    return app.handle({ method, path, body: raw, headers: { "x-uw-key": x, "x-uw-ts": ts, "x-uw-sig": sig, "x-uw-client": "9.9.9.9" } });
  };
  const get = (path: string, headers: Record<string, string> = {}) => app.handle({ method: "GET", path, headers, body: "" });

  assert.equal((await call("GET", "/api/waitlist/me")).status, 404, "not on the list yet");
  const joined = await call("POST", "/api/waitlist", { handle: "@zecfan", email: "fan@example.com" });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const code = (joined.body as { code: string }).code;
  assert.equal(((await call("GET", "/api/waitlist/me")).body as { code: string }).code, code);
  const card = (await get(`/api/waitlist/${code}`)).body as Record<string, unknown>;
  assert.deepEqual([card.handle, card.rank, card.points], ["zecfan", 1, 100]);
  assert.ok(!("email" in card), "no email in public cards");
  const list = (await get("/api/waitlist")).body as { count: number; top: Array<Record<string, unknown>> };
  assert.equal(list.count, 1);
  assert.ok(!JSON.stringify(list).includes("fan@example.com"));

  assert.equal((await get("/api/admin/waitlist")).status, 401);
  const exp = (await get("/api/admin/waitlist", { authorization: `Bearer ${token}` })).body as Array<{ email: string; account: string }>;
  assert.equal(exp[0]?.email, "fan@example.com");
  assert.equal(exp[0]?.account, accountId(Buffer.from(x, "base64url")));
});
