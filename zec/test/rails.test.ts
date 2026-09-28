import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Engine, FEES, LOSS, QUOTE, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { DEFAULT_POLICY, Rails, parseAnchorMemo, type RailsPolicy, type TickReport } from "../rails/rails.ts";
import { SimChain, zip317Fee } from "../rails/sim.ts";
import { DEFAULT_FEES, ZEC, assertInvariants, expectError, fund, makeEngine } from "./support.ts";

const USERS = ["alice", "bob", "mallory"];
const DEST = "utest1destination01";

/** Anchoring off: it has its own test, and would otherwise spend from the reserve mid-scenario. */
const POLICY: RailsPolicy = { ...DEFAULT_POLICY, anchorEveryMs: 0 };
/** Blocks for a sweep built at finality to confirm enough to spend (the sim's trusted depth). */
const SWEEP_SETTLE = 3;

function setup(float = 0n) {
  const engine = makeEngine();
  const sim = new SimChain(float);
  const rails = new Rails(engine, sim, POLICY);
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

/**
 * Deposit through the chain and wait for finality, then for the sweep into
 * the reserve to be spendable: a fully withdrawable balance the wallet can pay.
 */
async function deposit(sim: SimChain, rails: Rails, user: string, amount: bigint): Promise<void> {
  await rails.depositAddress(user);
  sim.receive(rails.engine.addressOf(user)?.index ?? -1, amount);
  await advance(sim, rails, DEFAULT_POLICY.finalityDepth + SWEEP_SETTLE);
}

/** Network fees the protocol has paid for settled sweeps and anchors. */
const treasuryFees = (engine: Engine): bigint =>
  engine.treasuryTxs("settled").reduce((s, t) => s + t.networkFee, 0n);

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
  const restarted = new Rails(engine, sim, POLICY);
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
  const dust = sim.receive(0, 50_000n); // over the old 0.0001 minimum, under 0.001
  sim.receive(99, ZEC);
  const report = (await advance(sim, rails, 3)).at(-1);
  assert.deepEqual(report?.ignored, [dust]);
  assert.ok(report?.alerts.some((a) => a.includes("unassigned address index 99")));
  assert.equal(engine.balance("alice"), 0n);
  const r = await rails.reconcile();
  assert.equal(r.drift, ZEC + 50_000n, "surplus shows up as positive drift, never negative");
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
  // Two users paid 10k each; the batch cost 15k on-chain, and the sweeps cost what they cost.
  // Fees pay first and loss covers the rest, so count them together.
  assert.equal(
    engine.ledger.balance(FEES, QUOTE) + engine.ledger.balance(LOSS, QUOTE),
    2n * DEFAULT_POLICY.withdrawalFee - zip317Fee(2) - treasuryFees(engine),
  );
  assert.equal(engine.treasuryTxs("settled").length, 2, "both sweeps final");
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

test("cold storage: the online reserve keeps 10% of what's owed, the rest goes cold, and a short reserve queues withdrawals until a top-up", async () => {
  const engine = makeEngine();
  const sim = new SimChain(0n, undefined, { cold: true });
  const rails = new Rails(engine, sim, POLICY);
  await deposit(sim, rails, "alice", 20n * ZEC);

  // Once the sweep is spendable the reserve is past 1.5x its 2 ZEC target, and the excess goes cold.
  await advance(sim, rails, 13);
  assert.equal(engine.treasuryTxs().filter((t) => t.purpose === "cold").length, 1);
  const b = await sim.balances();
  assert.ok(b.reserve.total >= 2n * ZEC && b.reserve.total < 2n * ZEC + ZEC / 10n, "about 10% of 20 ZEC stays online");
  assert.ok((b.cold?.total ?? 0n) > 17n * ZEC);
  assert.deepEqual(sim.paidOut(), [], "moving funds to cold isn't a payout");
  await assertReconciled(rails); // cold counts: nothing is missing

  // A withdrawal bigger than the online reserve waits, and nothing pauses: the books balance.
  await rails.requestWithdrawal("alice", DEST, 5n * ZEC);
  const short = await rails.tick();
  assert.equal(short.submitted.length, 0);
  assert.ok(short.alerts.some((a) => a.includes("could not build")));
  assert.equal(engine.withdrawalsPaused, null);

  // The operator sends from cold to the reserve address; the queue pays out.
  sim.topUpReserve(5n * ZEC, true);
  const after = await advance(sim, rails, DEFAULT_POLICY.finalityDepth);
  assert.equal(after.flatMap((r) => r.submitted).length, 1);
  await advance(sim, rails, 12);
  assert.deepEqual(sim.paidOut(), [{ address: DEST, amount: 5n * ZEC }]);
  assertInvariants(engine, USERS);
});

test("the online reserve running low raises a top-up alert naming the reserve address", async () => {
  const engine = makeEngine();
  const sim = new SimChain(0n, undefined, { cold: true });
  const rails = new Rails(engine, sim, POLICY);
  await deposit(sim, rails, "alice", 20n * ZEC);
  await advance(sim, rails, 13); // excess to cold, settled
  await rails.requestWithdrawal("alice", DEST, ZEC + ZEC / 2n);
  await advance(sim, rails, 13); // paid from the 2 ZEC online, leaving under half the target
  const r = await rails.tick();
  assert.ok(r.alerts.some((a) => a.startsWith("online wallet low") && a.includes("utest1simreserve0")), JSON.stringify(r.alerts));
});

test("emergency stop: ZEC owed that isn't in any wallet pauses withdrawals until an operator resumes them", async () => {
  const { engine, sim, rails } = setup();
  await deposit(sim, rails, "alice", 2n * ZEC);
  fund(engine, "mallory", 3n * ZEC); // a balance with no ZEC behind it: what a crediting bug looks like
  await rails.requestWithdrawal("mallory", DEST, 2n * ZEC);
  const r = await rails.tick();
  assert.ok(r.alerts.some((a) => a.startsWith("PAUSED")), JSON.stringify(r.alerts));
  assert.match(r.paused ?? "", /books don't balance/);
  assert.equal(r.submitted.length, 0, "nothing leaves while paused");
  await advance(sim, rails, 5);
  assert.deepEqual(sim.paidOut(), []);
  assert.equal(engine.withdrawalRecords("requested").length, 1, "the request keeps its place");

  expectError("InvalidState", () => engine.setWithdrawalsPaused(true, "again"));
  engine.setWithdrawalsPaused(false, "operator checked"); // resuming is a human decision...
  const again = await rails.tick();
  assert.ok(again.paused, "...and the guard pauses again while the books still don't balance");
});

test("emergency stop: withdrawals over a quarter of everything owed within an hour pause the rest", async () => {
  const engine = makeEngine(); // its clock starts at 1.7e12 and ticks a second per command
  const sim = new SimChain();
  const rails = new Rails(engine, sim, POLICY, () => 1_700_000_000_000 + 1_000_000);
  for (const u of ["alice", "bob"]) await deposit(sim, rails, u, 20n * ZEC);
  // 40 ZEC owed: the hourly limit is 10 ZEC.
  await rails.requestWithdrawal("alice", DEST, 6n * ZEC);
  assert.equal((await rails.tick()).submitted.length, 1);
  await rails.requestWithdrawal("bob", "utest1destination02", 6n * ZEC);
  const r = await rails.tick();
  assert.equal(r.submitted.length, 0);
  assert.match(r.paused ?? "", /hourly limit/);
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
  const rails1 = new Rails(first.engine, sim, POLICY);
  await deposit(sim, rails1, "alice", 2n * ZEC);
  await rails1.requestWithdrawal("alice", DEST, ZEC);
  sim.failNextBroadcasts(1);
  await rails1.tick(); // recorded, not broadcast, and then the process dies
  first.close();

  const second = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  const rails2: Rails = new Rails(second.engine, sim, POLICY);
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

test("deposits are swept into the reserve at finality, and only the reserve pays", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  sim.receive(0, 2n * ZEC);
  const reports = await advance(sim, rails, DEFAULT_POLICY.finalityDepth);
  assert.equal(reports.flatMap((r) => r.swept).length, 1, "swept once, at finality");
  assert.equal(reports.at(-1)?.swept.length, 1);
  const sweep = engine.treasuryTxs()[0];
  assert.equal(sweep?.purpose, "sweep");

  let b = await sim.balances();
  assert.equal(b.treasury.total, 0n);
  assert.equal(b.reserve.total, 2n * ZEC - (sweep?.networkFee ?? 0n));
  assert.equal(b.reserve.spendable, 0n, "a sweep isn't spendable until it confirms");
  await assertReconciled(rails);

  // Queued before the sweep confirms: it waits, then goes.
  await rails.requestWithdrawal("alice", DEST, ZEC);
  const waiting = await rails.tick();
  assert.equal(waiting.submitted.length, 0);
  assert.ok(waiting.alerts.some((a) => a.includes("could not build")));
  const later = await advance(sim, rails, SWEEP_SETTLE);
  assert.equal(later.flatMap((r) => r.submitted).length, 1);

  await advance(sim, rails, 12);
  assert.deepEqual(sim.paidOut(), [{ address: DEST, amount: ZEC }], "sweeps never count as payouts");
  assert.equal(engine.treasuryTx(sweep?.txid ?? "")?.state, "settled");
  b = await sim.balances();
  assert.equal(b.reserve.total, 2n * ZEC - (sweep?.networkFee ?? 0n) - ZEC - zip317Fee(1));
  assertInvariants(engine, USERS);
  await assertReconciled(rails);
});

test("the treasury isn't swept below sweepMin, then sweeps every note at once", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  sim.receive(0, 400_000n);
  sim.receive(0, 500_000n);
  await advance(sim, rails, 15);
  assert.equal(engine.treasuryTxs().length, 0, "0.009 ZEC is under the 0.01 minimum");
  assert.equal(engine.balance("alice"), 900_000n, "credited all the same");

  sim.receive(0, 300_000n);
  const reports = await advance(sim, rails, DEFAULT_POLICY.finalityDepth);
  assert.equal(reports.flatMap((r) => r.swept).length, 1);
  assert.equal(engine.treasuryTxs()[0]?.networkFee, 15_000n, "three notes, three actions");
  assert.equal((await sim.balances()).treasury.total, 0n);
  await assertReconciled(rails);
});

test("a sweep that expires is marked failed and its notes are swept again", async () => {
  const { engine, sim, rails } = setup();
  await rails.depositAddress("alice");
  sim.receive(0, ZEC);
  const first = (await advance(sim, rails, DEFAULT_POLICY.finalityDepth)).at(-1)?.swept[0] ?? "";
  sim.expire(first);
  const report = await rails.tick();
  assert.equal(engine.treasuryTx(first)?.state, "failed");
  assert.ok(report.alerts.some((a) => a.includes("expired")));
  assert.equal(report.swept.length, 1, "re-swept in the same tick");
  assert.notEqual(report.swept[0], first);

  await advance(sim, rails, 12);
  assert.equal((await sim.balances()).reserve.total, ZEC - zip317Fee(1));
  assert.equal(treasuryFees(engine), zip317Fee(1), "only the sweep that confirmed cost anything");
  assertInvariants(engine, USERS);
  await assertReconciled(rails);
});

test("anchors: the log's head goes into a reserve memo, at most hourly and only when it moved", async () => {
  let t = 1_700_000_000_000;
  const now = () => t;
  const engine = new Engine({ params: ZEC_PARAMS, fees: DEFAULT_FEES, clock: now });
  const sim = new SimChain(ZEC); // a float, so anchoring can pay its fee from the start
  const rails = new Rails(engine, sim, DEFAULT_POLICY, now);

  const verify = (memo: string) => {
    const a = parseAnchorMemo(memo);
    assert.ok(a, `not an anchor memo: ${memo}`);
    assert.equal(engine.chain.records[a.length - 1]?.hash, a.head, "the memo commits to a real log position");
  };

  await rails.depositAddress("alice");
  const first = await rails.tick();
  assert.equal(first.anchored.length, 1, "first tick anchors whatever exists");

  fund(engine, "alice", ZEC); // activity, but inside the hour
  t += 60_000;
  assert.equal((await rails.tick()).anchored.length, 0, "not twice in an hour");

  t += 3_600_000;
  assert.equal((await rails.tick()).anchored.length, 1, "an hour on, with activity: anchored");

  await advance(sim, rails, 12); // both anchors confirm and settle
  assert.equal(sim.anchors().length, 2);
  for (const memo of sim.anchors()) verify(memo);

  t += 3_600_000;
  assert.equal((await rails.tick()).anchored.length, 0, "nothing but anchor bookkeeping since: skipped");

  fund(engine, "alice", ZEC);
  t += 3_600_000;
  assert.equal((await rails.tick()).anchored.length, 1);
  await advance(sim, rails, 12);
  for (const memo of sim.anchors()) verify(memo);
  assert.equal(treasuryFees(engine), 3n * zip317Fee(1));
  // Anchors pay themselves back: only their fees ever leave the reserve.
  assert.equal((await sim.balances()).reserve.total, ZEC - 3n * zip317Fee(1));
  assertInvariants(engine, USERS);
});
