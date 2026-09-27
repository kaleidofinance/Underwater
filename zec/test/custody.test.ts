import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN, FEES, LOSS, PENDING_WITHDRAWALS, QUOTE, type Engine } from "../engine/index.ts";
import { ZEC, assertInvariants, expectError, fund, makeEngine } from "./support.ts";

const USERS = ["alice", "bob", "mallory"];

const launch = (e: Engine, user: string): string =>
  e.create(user, { name: "Pepe", symbol: "PEPE", metadataURI: "", value: e.fees.creationFee }).result.token;

test("an immature deposit trades immediately but can't leave until it matures", () => {
  const e = makeEngine();
  e.creditDeposit({ depositId: "tx1:orchard:0", user: "alice", amount: 2n * ZEC, mature: false });
  assert.equal(e.balance("alice"), 2n * ZEC);
  assert.equal(e.withdrawable("alice"), 0n);

  const token = launch(e, "alice");
  e.buy("alice", token, ZEC / 2n); // trading works
  expectError("ImmatureFunds", () =>
    e.requestWithdrawal({ withdrawalId: "w1", user: "alice", address: "utest1a", amount: ZEC / 10n, fee: 0n }),
  );

  e.matureDeposit("tx1:orchard:0");
  assert.equal(e.withdrawable("alice"), e.balance("alice"));
  e.requestWithdrawal({ withdrawalId: "w1", user: "alice", address: "utest1a", amount: ZEC / 10n, fee: 0n });
  assertInvariants(e, USERS);
});

test("a note is credited exactly once", () => {
  const e = makeEngine();
  e.creditDeposit({ depositId: "tx1:orchard:0", user: "alice", amount: ZEC, mature: true });
  const head = e.chain.head;
  expectError("DuplicateId", () => e.creditDeposit({ depositId: "tx1:orchard:0", user: "alice", amount: ZEC, mature: true }));
  expectError("DuplicateId", () => e.creditDeposit({ depositId: "tx1:orchard:0", user: "bob", amount: ZEC, mature: true }));
  assert.equal(e.balance("alice"), ZEC);
  assert.equal(e.balance("bob"), 0n);
  assert.equal(e.chain.head, head);
});

test("reorg of an unspent deposit: fully clawed back, protocol untouched", () => {
  const e = makeEngine();
  e.creditDeposit({ depositId: "d1", user: "alice", amount: ZEC, mature: false });
  const r = e.reverseDeposit("d1");
  assert.equal(e.balance("alice"), 0n);
  assert.equal(e.ledger.balance(CHAIN, QUOTE), 0n, "the liability is gone with the deposit");
  const ev = r.events[0];
  assert.ok(ev?.type === "DepositReversed");
  assert.equal(ev.clawedBack, ZEC);
  assert.equal(ev.coveredByFees + ev.coveredAsLoss, 0n);
  assertInvariants(e, USERS);
});

test("reorg of a deposit already spent: the protocol covers the shortfall from fees, then as loss", () => {
  const e = makeEngine();
  fund(e, "bob", 10n * ZEC);
  const token = launch(e, "bob");
  e.buy("bob", token, 2n * ZEC); // earns the protocol some fees

  // mallory's deposit gets credited at 3 confirmations, and they spend it on the curve...
  e.creditDeposit({ depositId: "phantom", user: "mallory", amount: ZEC, mature: false });
  e.buy("mallory", token, ZEC);
  assert.equal(e.balance("mallory"), 0n);
  const fees = e.ledger.balance(FEES, QUOTE);
  assert.ok(fees > 0n && fees < ZEC, "fees alone can't cover a whole ZEC");

  // ...then a reorg drops it.
  const ev = e.reverseDeposit("phantom").events[0];
  assert.ok(ev?.type === "DepositReversed");
  assert.equal(ev.clawedBack, 0n, "nothing left to take back");
  assert.equal(ev.coveredByFees, fees, "fees go first");
  assert.equal(ev.coveredAsLoss, ZEC - fees, "the rest is recorded, not hidden");
  assert.equal(e.ledger.balance(FEES, QUOTE), 0n);
  assert.equal(e.ledger.balance(LOSS, QUOTE), -(ZEC - fees));
  // mallory keeps tokens bought with phantom money: the exposure the fast-credit cap bounds.
  assert.ok(e.balance("mallory", token) > 0n);
  assertInvariants(e, USERS);
});

test("finality only moves forward", () => {
  const e = makeEngine();
  e.creditDeposit({ depositId: "m", user: "alice", amount: ZEC, mature: true });
  e.creditDeposit({ depositId: "r", user: "alice", amount: ZEC, mature: false });
  e.reverseDeposit("r");
  expectError("InvalidState", () => e.reverseDeposit("m"));
  expectError("InvalidState", () => e.matureDeposit("m"));
  expectError("InvalidState", () => e.matureDeposit("r"));
  expectError("InvalidState", () => e.reverseDeposit("r"));
  expectError("UnknownId", () => e.matureDeposit("nope"));
});

test("withdrawal lifecycle: request, submit before broadcast, settle", () => {
  const e = makeEngine();
  fund(e, "alice", 5n * ZEC);
  const fee = 10_000n;
  e.requestWithdrawal({ withdrawalId: "w1", user: "alice", address: "utest1a", amount: 2n * ZEC, fee });
  e.requestWithdrawal({ withdrawalId: "w2", user: "alice", address: "utest1b", amount: ZEC, fee });
  assert.equal(e.balance("alice"), 2n * ZEC - 2n * fee);
  assert.equal(e.ledger.balance(PENDING_WITHDRAWALS, QUOTE), 3n * ZEC);
  assertInvariants(e, USERS);

  e.submitWithdrawals("tx-a", ["w1", "w2"], 15_000n); // one tx, two outputs: less than two users' fees
  assert.equal(e.withdrawalRecord("w1")?.state, "submitted");
  assert.equal(e.withdrawalRecord("w1")?.txid, "tx-a");
  expectError("InvalidState", () => e.cancelWithdrawal("w1")); // in a transaction already
  expectError("DuplicateId", () => e.submitWithdrawals("tx-a", ["w1"], 0n));

  e.settleWithdrawals("tx-a");
  assert.equal(e.withdrawalRecord("w2")?.state, "settled");
  assert.equal(e.ledger.balance(PENDING_WITHDRAWALS, QUOTE), 0n);
  assert.equal(e.ledger.balance(CHAIN, QUOTE), -(5n * ZEC) + 3n * ZEC + 15_000n, "value and network fee left reserves");
  assert.equal(e.ledger.balance(FEES, QUOTE), 2n * fee - 15_000n, "batching nets the protocol the difference");
  expectError("InvalidState", () => e.settleWithdrawals("tx-a"));
  assertInvariants(e, USERS);
});

test("a failed transaction and a cancelled request both refund amount and fee", () => {
  const e = makeEngine();
  fund(e, "alice", 5n * ZEC);
  e.requestWithdrawal({ withdrawalId: "w1", user: "alice", address: "utest1a", amount: ZEC, fee: 10_000n });
  e.requestWithdrawal({ withdrawalId: "w2", user: "alice", address: "utest1a", amount: ZEC, fee: 10_000n });
  e.submitWithdrawals("tx-x", ["w1"], 10_000n);
  e.failWithdrawals("tx-x");
  e.cancelWithdrawal("w2");
  assert.equal(e.balance("alice"), 5n * ZEC);
  assert.equal(e.withdrawalRecord("w1")?.state, "failed");
  assert.equal(e.withdrawalRecord("w2")?.state, "cancelled");
  expectError("UnknownId", () => e.failWithdrawals("tx-nope"));
  assertInvariants(e, USERS);
});

test("deposit addresses are one per user and never shared", () => {
  const e = makeEngine();
  e.assignAddress("alice", 0, "utest1alice");
  expectError("DuplicateId", () => e.assignAddress("alice", 1, "utest1other"));
  expectError("DuplicateId", () => e.assignAddress("bob", 0, "utest1bob"));
  e.assignAddress("bob", 1, "utest1bob");
  assert.equal(e.ownerOfIndex(1), "bob");
  assert.equal(e.addressOf("alice")?.address, "utest1alice");
  assert.equal(e.nextAddressIndex, 2);
});

test("treasury transactions: recorded before broadcast, fee paid by the protocol only once final", () => {
  const e = makeEngine();
  fund(e, "alice", ZEC);
  const fees0 = e.ledger.balance(FEES, QUOTE);

  e.submitTreasuryTx({ txid: "sweep-1", purpose: "sweep", networkFee: 10_000n });
  assert.equal(e.treasuryTx("sweep-1")?.state, "submitted");
  assert.equal(e.ledger.balance(FEES, QUOTE), fees0, "nothing moves until it's final");
  expectError("DuplicateId", () => e.submitTreasuryTx({ txid: "sweep-1", purpose: "sweep", networkFee: 1n }));
  expectError("InvalidArgument", () => e.submitTreasuryTx({ txid: "x", purpose: "bogus" as "sweep", networkFee: 1n }));
  expectError("InvalidArgument", () => e.submitTreasuryTx({ txid: "y", purpose: "anchor", networkFee: 1n, memo: "m".repeat(513) }));

  e.settleTreasuryTx("sweep-1");
  // No fees collected yet, so the network fee is recorded loss: never silent.
  assert.equal(e.ledger.balance(FEES, QUOTE) + e.ledger.balance(LOSS, QUOTE), fees0 - 10_000n);
  expectError("InvalidState", () => e.settleTreasuryTx("sweep-1"));
  expectError("UnknownId", () => e.failTreasuryTx("nope"));

  e.submitTreasuryTx({ txid: "anchor-1", purpose: "anchor", networkFee: 10_000n, memo: "uwzec:anchor:v1:1:ab" });
  const before = e.ledger.balance(LOSS, QUOTE);
  e.failTreasuryTx("anchor-1");
  assert.equal(e.ledger.balance(LOSS, QUOTE), before, "a failed one cost nothing");
  assert.deepEqual(
    e.treasuryTxs().map((t) => [t.txid, t.state]),
    [
      ["sweep-1", "settled"],
      ["anchor-1", "failed"],
    ],
  );
  assert.equal(e.balance("alice"), ZEC, "nobody's balance moved");
  assertInvariants(e, USERS);

  // A replay of the log rebuilds exactly the same records.
  const replay = makeEngine();
  for (const r of e.chain.records) replay.execute((r.body as { command: Parameters<Engine["execute"]>[0] }).command);
  assert.deepEqual(
    replay.treasuryTxs().map((t) => [t.txid, t.state, t.networkFee, t.memo]),
    e.treasuryTxs().map((t) => [t.txid, t.state, t.networkFee, t.memo]),
  );
});
