import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { Engine, LiabilityTree, ZEC_LAUNCH_FEES, ZEC_PARAMS } from "../engine/index.ts";
import { DEFAULT_POLICY, Rails } from "../rails/rails.ts";
import { SimChain } from "../rails/sim.ts";
import { App, type ApiResponse } from "../server/app.ts";
import { accountId, signingPayload } from "../server/auth.ts";
import { Market } from "../server/market.ts";
import { assertInvariants } from "./support.ts";

const ZEC = 100_000_000n;

function setup() {
  let now = 1_800_000_000_000;
  const clock = () => (now += 1_000);
  const engine = new Engine({ params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES, clock });
  const sim = new SimChain();
  const rails = new Rails(engine, sim, DEFAULT_POLICY);
  const app = new App({ engine, rails, market: new Market(), sim, now: () => now });
  return { engine, sim, rails, app, advance: (ms: number) => (now += ms), now: () => now };
}

/** A user with an Ed25519 key, signing requests exactly as the browser will. */
function user(app: App, now: () => number) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const account = accountId(Buffer.from(x, "base64url"));
  const call = (method: string, path: string, body?: unknown, key: KeyObject = privateKey): Promise<ApiResponse> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String(now());
    const sig = sign(null, Buffer.from(signingPayload(method, path, ts, raw)), key).toString("base64url");
    return app.handle({ method, path, body: raw, headers: { "x-uw-key": x, "x-uw-ts": ts, "x-uw-sig": sig } });
  };
  return { account, x, call };
}

const get = (app: App, path: string) => app.handle({ method: "GET", path, headers: {}, body: "" });
const body = <T>(r: ApiResponse): T => r.body as T;

test("public reads need no auth; unknown routes 404", async () => {
  const { app } = setup();
  assert.equal((await get(app, "/api/health")).status, 200);
  assert.deepEqual(body<unknown[]>(await get(app, "/api/tokens")), []);
  assert.equal((await get(app, "/api/nope")).status, 404);
  assert.equal((await get(app, "/api/tokens/tok_9")).status, 400);
});

test("writes need a valid, fresh, unreplayed signature", async () => {
  const s = setup();
  const alice = user(s.app, s.now);

  assert.equal((await s.app.handle({ method: "GET", path: "/api/me", headers: {}, body: "" })).status, 401);

  // Signed by someone else's key under alice's public key.
  const { privateKey: mallory } = generateKeyPairSync("ed25519");
  const forged = await alice.call("GET", "/api/me", undefined, mallory);
  assert.equal(forged.status, 401);

  // Replay: the exact same signed request twice.
  const ts = String(s.now());
  const sigFor = (k: KeyObject) => sign(null, Buffer.from(signingPayload("GET", "/api/me", ts, "")), k).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const req = { method: "GET", path: "/api/me", body: "", headers: { "x-uw-key": x, "x-uw-ts": ts, "x-uw-sig": sigFor(privateKey) } };
  assert.equal((await s.app.handle(req)).status, 200);
  assert.equal(body<{ message: string }>(await s.app.handle(req)).message, "replayed request");

  // Stale: signed 5 minutes ago.
  const old = String(s.now() - 300_000);
  const staleSig = sign(null, Buffer.from(signingPayload("GET", "/api/me", old, "")), privateKey).toString("base64url");
  const stale = await s.app.handle({ ...req, headers: { "x-uw-key": x, "x-uw-ts": old, "x-uw-sig": staleSig } });
  assert.equal(body<{ message: string }>(stale).message, "stale or bad timestamp");

  // A tampered body breaks the signature.
  const ts2 = String(s.now());
  const good = sign(null, Buffer.from(signingPayload("POST", "/api/trade", ts2, '{"amount":"1"}')), privateKey).toString("base64url");
  const tampered = await s.app.handle({ method: "POST", path: "/api/trade", body: '{"amount":"999"}', headers: { "x-uw-key": x, "x-uw-ts": ts2, "x-uw-sig": good } });
  assert.equal(tampered.status, 401);
});

test("full flow: fund, launch, trade, graduate onto the DEX, withdraw", async () => {
  const s = setup();
  const alice = user(s.app, s.now);
  const bob = user(s.app, s.now);

  // Fund through the simulated chain: a deposit address, confirmations, credit.
  const funded = body<{ balance: string; withdrawable: string }>(await alice.call("POST", "/api/dev/faucet", { amount: String(10n * ZEC) }));
  assert.equal(funded.balance, String(10n * ZEC));
  assert.equal(funded.withdrawable, String(10n * ZEC));
  await bob.call("POST", "/api/dev/faucet", { amount: String(10n * ZEC) });
  const me = body<{ depositAddress: string; account: string }>(await alice.call("GET", "/api/me"));
  assert.equal(me.account, alice.account);
  assert.match(me.depositAddress, /^utest1sim/);

  // Launch with a first buy.
  const launched = await alice.call("POST", "/api/tokens", { name: "Pepe on Zcash", symbol: "ZPEPE", value: String(ZEC / 10n + ZEC_LAUNCH_FEES.creationFee) });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const token = body<{ token: string }>(launched).token;

  // Quote, then trade exactly the quote.
  const quote = body<{ venue: string; out: string }>(await get(s.app, `/api/quote?token=${token}&side=buy&amount=${ZEC}`));
  assert.equal(quote.venue, "curve");
  const bought = await bob.call("POST", "/api/trade", { token, side: "buy", amount: String(ZEC), minOut: quote.out });
  assert.equal(body<{ out: string }>(bought).out, quote.out);
  const tooGreedy = await bob.call("POST", "/api/trade", { token, side: "buy", amount: String(ZEC), minOut: String(10n ** 30n) });
  assert.equal(body<{ error: string }>(tooGreedy).error, "SlippageExceeded");

  const sold = await bob.call("POST", "/api/trade", { token, side: "sell", amount: String(BigInt(quote.out) / 2n) });
  assert.equal(sold.status, 200);

  // The market read model sees every trade, and candles exist.
  s.advance(120_000);
  const trades = body<Array<{ side: string; trader: string }>>(await get(s.app, `/api/tokens/${token}/trades`));
  assert.deepEqual(trades.map((t) => t.side), ["sell", "buy", "buy"], "newest first");
  const candles = body<Array<{ open: number; close: number }>>(await get(s.app, `/api/tokens/${token}/candles?interval=60`));
  assert.ok(candles.length >= 1 && candles.every((c) => c.close > 0));

  // Graduate with a big buy; the same endpoint then routes to the DEX.
  const grad = body<{ graduated: boolean; venue: string }>(await bob.call("POST", "/api/trade", { token, side: "buy", amount: String(7n * ZEC) }));
  assert.deepEqual([grad.venue, grad.graduated], ["curve", true]);
  const onDex = body<{ venue: string }>(await alice.call("POST", "/api/trade", { token, side: "buy", amount: String(ZEC / 10n) }));
  assert.equal(onDex.venue, "amm");
  const detail = body<{ graduated: boolean; amm: { quote: string } | null }>(await get(s.app, `/api/tokens/${token}`));
  assert.ok(detail.graduated && detail.amm);

  // Withdraw: request → submitted on a tick → settled after confirmations.
  const w = await alice.call("POST", "/api/withdrawals", { address: "utest1destination01", amount: String(ZEC) });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  await s.rails.tick();
  s.sim.mine(DEFAULT_POLICY.finalityDepth);
  await s.rails.tick();
  const after = body<{ withdrawals: Array<{ state: string }> }>(await alice.call("GET", "/api/me"));
  assert.equal(after.withdrawals[0]?.state, "settled");
  assert.deepEqual(s.sim.paidOut(), [{ address: "utest1destination01", amount: ZEC }]);

  const reserves = body<{ drift: string }>(await get(s.app, "/api/reserves"));
  assert.equal(reserves.drift, "0", "hot wallet matches the ledger");
  assertInvariants(s.engine, [alice.account, bob.account]);
});

test("bad input is refused with the engine's error, never a crash", async () => {
  const s = setup();
  const alice = user(s.app, s.now);
  await alice.call("POST", "/api/dev/faucet", {});
  const cases: Array<[unknown, string]> = [
    [{ name: "x".repeat(33), symbol: "X", value: "100000" }, "InvalidArgument"],
    [{ name: "X", symbol: "X", value: 100000 }, "InvalidArgument"], // a JSON number, not a string
    [{ name: "X", symbol: "X", value: "-5" }, "InvalidArgument"],
    [{ name: "X", symbol: "X", value: "1" }, "InsufficientCreationFee"],
    [{ name: "X", symbol: "X", value: String(1000n * ZEC) }, "InsufficientFunds"],
  ];
  for (const [payload, code] of cases) {
    const r = await alice.call("POST", "/api/tokens", payload);
    assert.equal(r.status, 400, JSON.stringify(payload));
    assert.equal(body<{ error: string }>(r).error, code, JSON.stringify(payload));
  }
  const notJson = await alice.call("POST", "/api/trade", "not an object");
  assert.equal(notJson.status, 400);
});

test("anyone can check solvency; each user can prove their balance is in it", async () => {
  const s = setup();
  const alice = user(s.app, s.now);
  const bob = user(s.app, s.now);
  await alice.call("POST", "/api/dev/faucet", { amount: String(3n * ZEC) });
  await bob.call("POST", "/api/dev/faucet", { amount: String(2n * ZEC) });
  await alice.call("POST", "/api/tokens", { name: "P", symbol: "P", value: String(ZEC) });

  const solvency = body<{ snapshot: { root: string; liabilities: string; leaves: number }; reserves: { drift: string } }>(
    await get(s.app, "/api/solvency"),
  );
  assert.equal(solvency.snapshot.liabilities, String(5n * ZEC), "everything deposited is owed to someone");
  assert.equal(solvency.reserves.drift, "0");

  const raw = body<{ snapshot: string; leaf: { id: string; amount: string }; path: Array<{ hash: string; sum: string; side: "left" | "right" }>; root: { hash: string; sum: string } }>(
    await alice.call("GET", "/api/me/proof"),
  );
  const proof = {
    snapshot: raw.snapshot,
    leaf: { id: raw.leaf.id, amount: BigInt(raw.leaf.amount) },
    path: raw.path.map((p) => ({ ...p, sum: BigInt(p.sum) })),
    root: { hash: raw.root.hash, sum: BigInt(raw.root.sum) },
  };
  assert.equal(proof.leaf.id, alice.account);
  assert.ok(LiabilityTree.verify(proof));
  assert.equal(proof.root.hash, solvency.snapshot.root, "the proof hangs off the published root");

  const stranger = user(s.app, s.now);
  assert.equal((await stranger.call("GET", "/api/me/proof")).status, 400, "no balance, no leaf");
});

test("the audit endpoint publishes the reserve viewing key and every anchor", async () => {
  const s = setup();
  const alice = user(s.app, s.now);
  await alice.call("POST", "/api/me/address");
  await alice.call("POST", "/api/dev/faucet", { amount: String(2n * ZEC) }); // mined to finality
  await s.rails.tick(); // credited, matured, swept
  s.sim.mine(3);
  await s.rails.tick(); // the sweep is spendable, so the first anchor goes out

  const audit = body<{
    reserve: { ufvk: string; address: string };
    anchors: Array<{ length: number; head: string; txid: string; state: string }>;
    sweeps: number;
  }>(await get(s.app, "/api/audit"));
  assert.ok(audit.reserve.ufvk.startsWith("uview"));
  assert.equal(audit.sweeps, 1);
  assert.equal(audit.anchors.length, 1);
  const [a] = audit.anchors;
  assert.equal(s.engine.chain.records[(a?.length ?? 0) - 1]?.hash, a?.head, "anchored a real log position");

  const reserves = body<{ reserve: { total: string }; treasury: { total: string }; inFlight: number; drift: string }>(
    await get(s.app, "/api/reserves"),
  );
  assert.equal(reserves.treasury.total, "0", "everything swept");
  assert.equal(reserves.inFlight, 2, "the sweep and the anchor are still confirming");
  assert.equal(reserves.drift, "0");
});

test("token images: uploaded signed, served safely, and the only images a launch may use", async () => {
  const s = setup();
  const alice = user(s.app, s.now);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

  const unsigned = await s.app.handle({ method: "POST", path: "/api/images", headers: {}, body: JSON.stringify({ data: png.toString("base64") }) });
  assert.equal(unsigned.status, 401);
  assert.equal((await alice.call("POST", "/api/images", { data: "not base64!" })).status, 400);
  const svg = Buffer.from("<svg onload=alert(1)>").toString("base64");
  assert.equal((await alice.call("POST", "/api/images", { data: svg })).status, 400, "SVG refused");

  const up = body<{ id: string; uri: string }>(await alice.call("POST", "/api/images", { data: png.toString("base64") }));
  assert.equal(up.uri, `/api/images/${up.id}`);
  const served = await get(s.app, up.uri);
  assert.equal(served.status, 200);
  assert.equal(served.raw?.type, "image/png");
  assert.deepEqual(Buffer.from(served.raw?.bytes ?? []), png);
  assert.equal((await get(s.app, `/api/images/${"0".repeat(64)}.png`)).status, 404);

  await alice.call("POST", "/api/dev/faucet", { amount: String(ZEC) });
  const launch = (metadataURI: string) =>
    alice.call("POST", "/api/tokens", { name: "Pic", symbol: "PIC", metadataURI, value: String(ZEC / 100n) });
  assert.equal((await launch("https://tracker.example/pixel.png")).status, 400, "outside hosts refused");
  assert.equal((await launch(`/api/images/${"f".repeat(64)}.png`)).status, 400, "never-uploaded refused");
  const ok = await launch(up.uri);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const token = body<{ token: string }>(ok).token;
  assert.equal(body<{ metadataURI: string }>(await get(s.app, `/api/tokens/${token}`)).metadataURI, up.uri);
  assert.equal((await launch("")).status, 200, "no image is still fine");
});
