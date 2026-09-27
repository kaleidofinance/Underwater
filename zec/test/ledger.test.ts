import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger, QUOTE } from "../engine/index.ts";
import { Rng } from "../parity/rng.ts";
import { expectError } from "./support.ts";

test("transfers move value and zero is a no-op", () => {
  const l = new Ledger();
  l.transfer("in", "chain", "user:a", QUOTE, 10n);
  l.transfer("pay", "user:a", "user:b", QUOTE, 4n);
  l.transfer("nothing", "user:a", "user:b", QUOTE, 0n);
  assert.equal(l.balance("user:a", QUOTE), 6n);
  assert.equal(l.balance("user:b", QUOTE), 4n);
  assert.equal(l.balance("chain", QUOTE), -10n);
  assert.equal(l.journal.length, 2);
  l.verify();
});

test("only source accounts may go negative, and a rejected entry changes nothing", () => {
  const l = new Ledger();
  l.transfer("in", "chain", "user:a", QUOTE, 5n);
  expectError("InsufficientFunds", () => l.transfer("overdraw", "user:a", "user:b", QUOTE, 6n));
  assert.equal(l.balance("user:a", QUOTE), 5n);
  assert.equal(l.balance("user:b", QUOTE), 0n);
  assert.equal(l.journal.length, 1);
  l.transfer("mint", "mint:tok_0", "curve:tok_0", "tok_0", 100n);
  assert.equal(l.balance("mint:tok_0", "tok_0"), -100n);
});

test("an entry must balance per asset", () => {
  const l = new Ledger();
  expectError("InvariantViolation", () =>
    l.post("bad", [
      { account: "chain", asset: QUOTE, amount: -5n },
      { account: "user:a", asset: QUOTE, amount: 4n },
    ]),
  );
  expectError("InvalidArgument", () => l.transfer("bad", "chain", "user:a|x", QUOTE, 1n));
});

test("rollback restores balances and truncates the journal", () => {
  const l = new Ledger();
  l.transfer("in", "chain", "user:a", QUOTE, 10n);
  l.begin();
  l.transfer("x", "user:a", "user:b", QUOTE, 3n);
  l.transfer("y", "user:b", "user:c", QUOTE, 3n);
  l.rollback();
  assert.equal(l.balance("user:a", QUOTE), 10n);
  assert.equal(l.balance("user:b", QUOTE), 0n);
  assert.equal(l.balance("user:c", QUOTE), 0n);
  assert.equal(l.journal.length, 1);
  l.begin();
  expectError("InvariantViolation", () => l.begin());
  l.commit();
  l.verify();
});

test("random activity always nets to zero and rebuilds from the journal", () => {
  const r = new Rng(42);
  const l = new Ledger();
  const accounts = ["user:a", "user:b", "user:c", "fees", "curve:tok_0"];
  for (let i = 0; i < 3_000; i++) {
    const from = r.chance(0.2) ? "chain" : r.pick(accounts);
    const to = r.pick(accounts);
    const available = from === "chain" ? 1_000n : l.balance(from, QUOTE);
    const amount = r.below(available + (r.chance(0.1) ? 5n : 0n));
    try {
      l.transfer("t", from, to, QUOTE, amount);
    } catch {
      /* overdraws are expected to be rejected */
    }
  }
  l.verify();
  assert.equal(l.total(QUOTE), 0n);
});
