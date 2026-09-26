import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FEES, QUOTE, ZEC_PARAMS, openEngine, type Engine } from "../engine/index.ts";
import { DEFAULT_POLICY, Rails, type TickReport } from "../rails/rails.ts";
import { SimChain, zip317Fee } from "../rails/sim.ts";
import { DEFAULT_FEES, ZEC, assertInvariants, expectError, fund, makeEngine } from "./support.ts";

const USERS = ["alice", "bob", "mallory"];
const DEST = "utest1destination01";

function setup(float = 0n) {
  const engine = makeEngine();
  const sim = new SimChain(float);
  const rails = new Rails(engine, sim);
  return { engine, sim, rails };
}

/** Mine one block at a time, ticking after each. Returns every report. */
async function advance(sim: SimChain, rails: Rails, blocks: number): Promise<TickReport[]> {
  const reports: TickReport[] = [];
  for (let i = 0; i < blocks; i++) {
    sim.mine();
    reports.push(await rails.tick());
  }
  return reports;
}

async function assertReconciled(rails: Rails): Promise<void> {
  const r = await rails.reconcile();
  assert.equal(r.drift, 0n, `hot wallet ${r.actual} vs ledger ${r.expected}`);
}

const txidOf = (noteId: string): string => noteId.split(":")[0] ?? "";

/** Deposit through the chain and wait for finality: a fully withdrawable balance. */
async function deposit(sim: SimChain, rails: Rails, user: string, amount: bigint): Promise<void> {
  await rails.depositAddress(user);
  sim.receive(rails.engine.addressOf(user)?.index ?? -1, amount);
  await advance(sim, rails, DEFAULT_POLICY.finalityDepth);
}

test("deposit: credited at 3 confirmations, withdrawable at 10", async () => {
  const { engine, sim, rails } = setup();
  const address = await rails.depositAddress("alice");
  assert.equal(await rails.depositAddress("alice"), address, "one address per user");
  assert.notEqual(await rails.depositAddress("bob"), address);

  sim.receive(0, ZEC);
  await advance(sim, rails, 2);
  assert.equal(engine.balance("alice"), 0n, "2 confirmations: not yet");

  const [third] = await advance(sim, rails, 1);
  assert.equal(third?.credited.length, 1);
  assert.equal(engine.balance("alice"), ZEC, "3 confirmations: tradable");
  assert.equal(engine.withdrawable("alice"), 0n, "...but not withdrawable");

  await advance(sim, rails, 6);
  assert.equal(engine.withdrawable("alice"), 0n, "9 confirmations: still not");
  const [tenth] = await advance(sim, rails, 1);
  assert.equal(tenth?.matured.length, 1);
  assert.equal(engine.withdrawable("alice"), ZEC, "10 confirmations: final");
  assertInvariants(engine, USERS);
  await assertReconciled(rails);
});

test("each note is credited exactly once, across ticks and across restarts", async () => {
  const { engine, sim, rails } = setup();
  await deposit(sim, rails, "alice", ZEC);
  for (let i = 0; i < 5; i++) await rails.tick();
  // A fresh process over the same log rescans everything since birthday.
  const restarted = new Rails(engine, sim);
  const report = await restarted.tick();
  assert.equal(report.credited.length, 0);
  assert.equal(engine.balance("alice"), ZEC);
});

test("deposits over the fast-credit cap wait for finality", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  sim.receive(0, 6n * ZEC); // cap is 5
  await advance(sim, rails, 9);
  assert.equal(engine.balance("alice"), 0n);
  await advance(sim, rails, 1);
  assert.equal(engine.balance("alice"), 6n * ZEC);
  assert.equal(engine.withdrawable("alice"), 6n * ZEC, "credited already final");
});

test("a reorg that drops a spent deposit reverses it and the protocol covers the gap", async () => {
  const { engine, sim, rails } = setup();
  await deposit(sim, rails, "bob", 3n * ZEC);
  const token = engine.create("bob", { name: "Pepe", symbol: "PEPE", metadataURI: "", value: engine.fees.creationFee }).result.token;
  engine.buy("bob", token, 2n * ZEC);

  await rails.depositAddress("mallory");
  const note = sim.receive(engine.addressOf("mallory")?.index ?? -1, ZEC);
  await advance(sim, rails, 3);
  assert.equal(engine.balance("mallory"), ZEC);
  engine.buy("mallory", token, ZEC); // spends it immediately

  sim.reorg(3, [txidOf(note)]); // double-spent away
  sim.mine(4);
  const report = await rails.tick();
  assert.deepEqual(report.reversed, [note]);
  assert.ok(report.alerts.some((a) => a.includes("reorg dropped")));
  assert.equal(engine.balance("mallory"), 0n);
  assertInvariants(engine, USERS);
  await assertReconciled(rails); // the hot wallet never got that ZEC, and the ledger agrees
});

test("a reorg that re-mines the deposit reverses, then re-credits it once", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  const note = sim.receive(0, ZEC);
  await advance(sim, rails, 3);
  assert.equal(engine.balance("alice"), ZEC);

  sim.reorg(3); // back to the mempool, not dropped
  const during = await rails.tick();
  assert.deepEqual(during.reversed, [note]);
  assert.equal(engine.balance("alice"), 0n);

  const after = await advance(sim, rails, 10);
  assert.deepEqual(after.flatMap((r) => r.credited), [`${note}/r1`]);
  assert.equal(engine.balance("alice"), ZEC, "credited exactly once in the end");
  assert.equal(engine.withdrawable("alice"), ZEC);
  assertInvariants(engine, USERS);
  await assertReconciled(rails);
});

test("payments to unassigned addresses and dust are reported, not credited", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  const dust = sim.receive(0, 5_000n);
  sim.receive(99, ZEC);
  const report = (await advance(sim, rails, 3)).at(-1);
  assert.deepEqual(report?.ignored, [dust]);
  assert.ok(report?.alerts.some((a) => a.includes("unassigned address index 99")));
  assert.equal(engine.balance("alice"), 0n);
  const r = await rails.reconcile();
  assert.equal(r.drift, ZEC + 5_000n, "surplus shows up as positive drift, never negative");
});

test("withdrawals: batched into one tx, recorded before broadcast, settled at finality", async () => {
  const { engine, sim, rails } = setup();
  await deposit(sim, rails, "alice", 3n * ZEC);
  await deposit(sim, rails, "bob", 2n * ZEC);

  const w1 = await rails.requestWithdrawal("alice", DEST, ZEC);
  const w2 = await rails.requestWithdrawal("bob", "utest1destination02", ZEC / 2n);
  assert.equal(engine.balance("alice"), 2n * ZEC - DEFAULT_POLICY.withdrawalFee);

  const first = await rails.tick();
  assert.equal(first.submitted.length, 1, "one transaction for both");
  const txid = first.submitted[0] ?? "";
  assert.equal(engine.withdrawalRecord(w1)?.txid, txid);
  assert.equal(engine.withdrawalRecord(w2)?.state, "submitted");
  assert.deepEqual(await sim.status(txid), { state: "mempool" });
  await assertReconciled(rails);

  const reports = await advance(sim, rails, 10);
  assert.deepEqual(reports.flatMap((r) => r.settled), [txid]);
  assert.equal(engine.withdrawalRecord(w1)?.state, "settled");
  assert.deepEqual(sim.paidOut(), [
    { address: DEST, amount: ZEC },
    { address: "utest1destination02", amount: ZEC / 2n },
  ]);
  // Two users paid 10k each; the batch cost 15k on-chain.
  assert.equal(engine.ledger.balance(FEES, QUOTE), 2n * DEFAULT_POLICY.withdrawalFee - zip317Fee(2));
  assertInvariants(engine, USERS);
  await assertReconciled(rails);
});

test("an expired withdrawal transaction is refunded, never paid", async () => {
  const { engine, sim, rails } = setup();
  await deposit(sim, rails, "alice", 2n * ZEC);
  const id = await rails.requestWithdrawal("alice", DEST, ZEC);
  const txid = (await rails.tick()).submitted[0] ?? "";
  sim.expire(txid);
  const report = await rails.tick();
  assert.deepEqual(report.failed, [txid]);
  assert.equal(engine.withdrawalRecord(id)?.state, "failed");
  assert.equal(engine.balance("alice"), 2n * ZEC);
  await advance(sim, rails, 12);
  assert.deepEqual(sim.paidOut(), []);
  await assertReconciled(rails);
});

test("a crash between recording and broadcasting resends the same transaction, once", async () => {
  const { engine, sim, rails } = setup();
  await deposit(sim, rails, "alice", 2n * ZEC);
  await rails.requestWithdrawal("alice", DEST, ZEC);
  sim.failNextBroadcasts(1);
  const first = await rails.tick();
  const txid = first.submitted[0] ?? "";
  assert.ok(first.alerts.some((a) => a.includes("broadcast of")));
  assert.deepEqual(await sim.status(txid), { state: "unknown" });

  const second = await rails.tick();
  assert.deepEqual(second.rebroadcast, [txid]);
  assert.equal(second.submitted.length, 0, "not rebuilt: resent");
  await advance(sim, rails, 10);
  assert.deepEqual(sim.paidOut(), [{ address: DEST, amount: ZEC }]);
  assert.equal(engine.withdrawalRecords("settled").length, 1);
});

test("a hot wallet short of funds leaves withdrawals queued until it's topped up", async () => {
  const { engine, sim, rails } = setup();
  fund(engine, "alice", 2n * ZEC); // credited in the ledger, but the ZEC is in cold storage
  await rails.requestWithdrawal("alice", DEST, ZEC);
  const short = await rails.tick();
  assert.equal(short.submitted.length, 0);
  assert.ok(short.alerts.some((a) => a.includes("could not build")));
  assert.equal(engine.withdrawalRecords("requested").length, 1);

  sim.receive(9_999, 5n * ZEC); // treasury top-up to a non-user index
  sim.mine();
  const topped = await rails.tick();
  assert.equal(topped.submitted.length, 1);
});

test("the rails catch up after stalling longer than the scan window", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  await rails.tick(); // running normally...
  sim.receive(0, ZEC);
  sim.mine(40); // ...then stalled for 40 blocks, twice the window
  await rails.tick();
  assert.equal(engine.balance("alice"), ZEC);
  assert.equal(engine.withdrawable("alice"), ZEC);
});

test("withdrawal requests are validated", async () => {
  const { sim, rails } = setup();
  await deposit(sim, rails, "alice", 2n * ZEC);
  await assert.rejects(rails.requestWithdrawal("alice", "t1transparentnope", ZEC), /not a valid Zcash address/);
  await assert.rejects(rails.requestWithdrawal("alice", DEST, 1_000n), /minimum withdrawal/);
  await assert.rejects(rails.requestWithdrawal("alice", DEST, 5n * ZEC), /InsufficientFunds/);
});

test("a restart mid-withdrawal resumes from the log without double-crediting or double-paying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uwzec-rails-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "engine.jsonl");
  const sim = new SimChain();

  const first = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  const rails1 = new Rails(first.engine, sim);
  await deposit(sim, rails1, "alice", 2n * ZEC);
  await rails1.requestWithdrawal("alice", DEST, ZEC);
  sim.failNextBroadcasts(1);
  await rails1.tick(); // recorded, not broadcast, and then the process dies
  first.close();

  const second = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  const rails2: Rails = new Rails(second.engine, sim);
  const report = await rails2.tick(); // full rescan + resend
  assert.equal(report.credited.length, 0, "no double credit");
  assert.equal(report.rebroadcast.length, 1);
  await advance(sim, rails2, 10);
  assert.deepEqual(sim.paidOut(), [{ address: DEST, amount: ZEC }], "paid exactly once");
  assert.equal(second.engine.balance("alice"), ZEC - DEFAULT_POLICY.withdrawalFee);
  assertInvariants(second.engine as Engine, USERS);
  await assertReconciled(rails2);
  second.close();
});

test("policy guards: the scan window must cover finality", () => {
  const e = makeEngine();
  expectError("InvalidConfig", () => new Rails(e, new SimChain(), { ...DEFAULT_POLICY, scanWindow: 10 }));
  expectError("InvalidConfig", () => new Rails(e, new SimChain(), { ...DEFAULT_POLICY, creditDepth: 11 }));
});
