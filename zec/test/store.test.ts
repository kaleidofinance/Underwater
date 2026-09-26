import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EVM_PARAMS, Engine, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { DEFAULT_FEES, ZEC, assertInvariants, expectError } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "uwzec-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const freshPath = (): string => join(dir, `log-${++n}.jsonl`);
const open = (path: string) => openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });

/** A little history touching every kind of state: custody, curves, the DEX, fees. */
function populate(e: Engine): string {
  e.assignAddress("alice", 0, "utest1alice");
  e.creditDeposit({ depositId: "d1", user: "alice", amount: 20n * ZEC, mature: true });
  e.creditDeposit({ depositId: "d2", user: "bob", amount: 5n * ZEC, mature: false });
  const token = e.create("alice", { name: "Pepe", symbol: "PEPE", metadataURI: "", value: ZEC }).result.token;
  e.buy("bob", token, 2n * ZEC);
  e.buy("alice", token, 7n * ZEC); // graduates
  e.swapQuoteForTokens("bob", token, ZEC);
  e.setTradeFeeBps(50n);
  e.requestWithdrawal({ withdrawalId: "w1", user: "alice", address: "utest1out", amount: ZEC, fee: 10_000n });
  e.submitWithdrawals("tx1", ["w1"], 10_000n);
  e.matureDeposit("d2");
  return token;
}

function snapshot(e: Engine, token: string) {
  return {
    head: e.chain.head,
    length: e.chain.length,
    alice: e.balance("alice"),
    bob: e.balance("bob"),
    bobTokens: e.balance("bob", token),
    pool: e.pool(token),
    fees: e.fees,
    w1: e.withdrawalRecord("w1"),
  };
}

test("a reopened log reproduces the exact state and hash chain, and keeps appending", () => {
  const path = freshPath();
  const first = open(path);
  const token = populate(first.engine);
  const before = snapshot(first.engine, token);
  first.close();

  const second = open(path);
  assert.equal(second.replayed, before.length);
  assert.deepEqual(snapshot(second.engine, token), before);
  assertInvariants(second.engine, ["alice", "bob"]);

  second.engine.settleWithdrawals("tx1");
  const head = second.engine.chain.head;
  second.close();

  const third = open(path);
  assert.equal(third.engine.chain.head, head);
  assert.equal(third.engine.withdrawalRecord("w1")?.state, "settled");
  assert.equal(third.engine.fees.tradeFeeBps, 50n, "fee changes replay too");
  third.close();
});

test("an edited log refuses to open", () => {
  const path = freshPath();
  const opened = open(path);
  populate(opened.engine);
  opened.close();

  // Quietly add a zero to alice's deposit.
  const text = readFileSync(path, "utf8");
  const forged = text.replace('"amount":"2000000000"', '"amount":"20000000000"');
  assert.notEqual(forged, text);
  writeFileSync(path, forged);
  expectError("InvariantViolation", () => open(path));
});

test("a torn final write is cut off and the log opens at the last whole command", () => {
  const path = freshPath();
  const opened = open(path);
  opened.engine.creditDeposit({ depositId: "d1", user: "alice", amount: ZEC, mature: true });
  const head = opened.engine.chain.head;
  opened.close();

  appendFileSync(path, '{"seq":1,"prev":"'); // crashed mid-line
  const reopened = open(path);
  assert.equal(reopened.truncatedTail, true);
  assert.equal(reopened.engine.chain.head, head);
  assert.equal(reopened.engine.balance("alice"), ZEC);
  reopened.engine.creditDeposit({ depositId: "d2", user: "alice", amount: ZEC, mature: true }); // and keeps going
  reopened.close();
  assert.equal(open(path).engine.balance("alice"), 2n * ZEC);
});

test("a log can't be opened with different curve parameters", () => {
  const path = freshPath();
  open(path).close();
  expectError("InvalidConfig", () => openEngine(path, { params: EVM_PARAMS, fees: DEFAULT_FEES }));
});

test("if persisting fails, the command never happened", () => {
  let failing = false;
  const e = new Engine({
    params: ZEC_PARAMS,
    fees: DEFAULT_FEES,
    onCommit: () => {
      if (failing) throw new Error("disk full");
    },
  });
  e.creditDeposit({ depositId: "d1", user: "alice", amount: ZEC, mature: true });
  const head = e.chain.head;
  failing = true;
  assert.throws(() => e.creditDeposit({ depositId: "d2", user: "alice", amount: ZEC, mature: true }), /disk full/);
  assert.equal(e.balance("alice"), ZEC);
  assert.equal(e.chain.head, head);
  assert.equal(e.depositRecord("d2"), undefined);
  failing = false;
  e.creditDeposit({ depositId: "d2", user: "alice", amount: ZEC, mature: true }); // the id was never burned
  assert.equal(e.balance("alice"), 2n * ZEC);
  assert.equal(e.chain.length, 2);
});
