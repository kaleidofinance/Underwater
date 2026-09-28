import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, ZEC_LAUNCH_FEES, ZEC_PARAMS } from "../engine/index.ts";
import { DEFAULT_POLICY, Rails } from "../rails/rails.ts";
import { SimChain } from "../rails/sim.ts";
import { Alerter, RailsWatch } from "../server/alerts.ts";
import { App } from "../server/app.ts";
import { Market } from "../server/market.ts";
import { RateLimiter, clientKey } from "../server/ratelimit.ts";

function fakeFetch() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}");
  }) as unknown as typeof fetch;
  return { f, sent };
}

test("alerts reach Telegram and a webhook, hold back repeats, but never hold back a critical one", async () => {
  let now = 0;
  const { f, sent } = fakeFetch();
  const a = new Alerter({ telegramToken: "T", telegramChatId: "42", webhookUrl: "https://hook", label: "[zec]", now: () => now, fetch: f, log: () => {} });
  assert.ok(a.routed);
  assert.equal(await a.send("warn", "could not build"), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.url, "https://api.telegram.org/botT/sendMessage");
  assert.equal(sent[0]?.body.chat_id, "42");
  assert.match(String(sent[1]?.body.content), /\[zec\] WARN could not build/);
  assert.equal(await a.send("warn", "could not build"), false, "the same warning inside 30 minutes is held back");
  now += 31 * 60_000;
  assert.equal(await a.send("warn", "could not build"), true);
  assert.equal(await a.send("critical", "ZEC MISSING"), true);
  assert.equal(await a.send("critical", "ZEC MISSING"), true, "critical always goes");
});

test("the rails watch pages on a run of failed ticks, on recovery, on pauses and on missing ZEC", async () => {
  const lines: string[] = [];
  const w = new RailsWatch(new Alerter({ log: (l) => lines.push(l) }), 3);
  await w.tickFailed("wallet unreachable");
  await w.tickFailed("wallet unreachable");
  assert.equal(lines.length, 0, "two blips are not an incident");
  await w.tickFailed("wallet unreachable");
  assert.match(lines.at(-1) ?? "", /CRITICAL rails failing 3 ticks/);
  await w.tickOk(["PAUSED withdrawals: the books don't balance"]);
  assert.match(lines.at(-2) ?? "", /INFO rails recovered/);
  assert.match(lines.at(-1) ?? "", /CRITICAL PAUSED/);
  await w.reconciled({ expected: 10n, actual: 5n, drift: -5n, inFlight: 0 });
  assert.match(lines.at(-1) ?? "", /CRITICAL ZEC MISSING/);
  const n = lines.length;
  await w.reconciled({ expected: 10n, actual: 5n, drift: -5n, inFlight: 1 });
  assert.equal(lines.length, n, "nothing is missing while a transfer is in flight");
});

test("rate limits: a burst, then a steady refill, per client", () => {
  let now = 0;
  const r = new RateLimiter({ burst: 3, perMinute: 60 }, () => now);
  for (let i = 0; i < 3; i++) assert.equal(r.take("a"), 0);
  assert.equal(r.take("a"), 1, "fourth in a burst waits a second");
  assert.equal(r.take("b"), 0, "other clients are unaffected");
  now += 1_000;
  assert.equal(r.take("a"), 0);
  assert.equal(clientKey({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, "10.0.0.1"), "203.0.113.9");
  assert.equal(clientKey({}, "127.0.0.1"), "127.0.0.1");
});

test("the operator route resumes withdrawals with the admin token, and doesn't exist without one", async () => {
  const token = "a".repeat(40);
  const engine = new Engine({ params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  const rails = new Rails(engine, new SimChain(), DEFAULT_POLICY);
  const app = new App({ engine, rails, market: new Market(), adminToken: token });
  const call = (auth: string, body: unknown) =>
    app.handle({ method: "POST", path: "/api/admin/withdrawals", headers: { authorization: auth }, body: JSON.stringify(body) });

  engine.setWithdrawalsPaused(true, "test");
  assert.equal((await call("Bearer wrong", { paused: false, reason: "x" })).status, 401);
  const ok = await call(`Bearer ${token}`, { paused: false, reason: "checked the books" });
  assert.equal(ok.status, 200);
  assert.equal(engine.withdrawalsPaused, null);
  const stats = await app.handle({ method: "GET", path: "/api/stats", headers: {}, body: "" });
  assert.equal((stats.body as { withdrawalsPaused: unknown }).withdrawalsPaused, null);

  const bare = new App({ engine, rails, market: new Market() });
  assert.equal((await bare.handle({ method: "POST", path: "/api/admin/withdrawals", headers: {}, body: "{}" })).status, 404);
});

test("a pause and a cold transfer survive the durable log, replayed to the same hash", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openEngine } = await import("../engine/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "uwzec-hard-"));
  try {
    const path = join(dir, "engine.jsonl");
    const a = openEngine(path, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
    a.engine.submitTreasuryTx({ txid: "cold-1", purpose: "cold", networkFee: 10_000n, amount: 5n * 100_000_000n });
    a.engine.submitTreasuryTx({ txid: "sweep-1", purpose: "sweep", networkFee: 10_000n });
    a.engine.setWithdrawalsPaused(true, "books");
    const head = a.engine.chain.head;
    a.close();
    const b = openEngine(path, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
    assert.equal(b.engine.chain.head, head);
    assert.equal(b.engine.treasuryTx("cold-1")?.amount, 500_000_000n);
    assert.equal(b.engine.treasuryTx("sweep-1")?.amount, 0n);
    assert.equal(b.engine.withdrawalsPaused?.reason, "books");
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
