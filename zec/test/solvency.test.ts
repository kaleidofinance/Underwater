import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGGREGATE,
  CHAIN,
  LOSS,
  LiabilityTree,
  QUOTE,
  snapshotLiabilities,
  type InclusionProof,
} from "../engine/index.ts";
import { Rng } from "../parity/rng.ts";
import { DEFAULT_POLICY, Rails } from "../rails/rails.ts";
import { SimChain } from "../rails/sim.ts";
import { ZEC, fund, makeEngine } from "./support.ts";

test("every leaf's proof verifies, and the root sums every liability", () => {
  const r = new Rng(21);
  for (const size of [1, 2, 3, 7, 8, 33]) {
    const leaves = Array.from({ length: size }, (_, i) => ({ id: `acct${i}`, amount: r.below(10n ** 12n) }));
    const tree = new LiabilityTree("5:abc", leaves);
    assert.equal(tree.root.sum, leaves.reduce((s, l) => s + l.amount, 0n));
    for (const l of leaves) {
      const proof = tree.proof(l.id);
      assert.ok(proof && LiabilityTree.verify(proof), `size ${size}, ${l.id}`);
      assert.equal(proof.leaf.amount, l.amount);
    }
    assert.equal(tree.proof("nobody"), null);
  }
});

test("a proof can't be bent: amount, sibling sums, leaf id and snapshot are all bound", () => {
  const tree = new LiabilityTree("9:def", [
    { id: "alice", amount: 500n },
    { id: "bob", amount: 300n },
    { id: "carol", amount: 200n },
  ]);
  const proof = tree.proof("bob") as InclusionProof;
  const bent = (p: Partial<InclusionProof>) => LiabilityTree.verify({ ...proof, ...p });

  assert.equal(bent({ leaf: { ...proof.leaf, amount: 3000n } }), false, "inflated balance");
  assert.equal(bent({ leaf: { ...proof.leaf, id: "alice" } }), false, "someone else's leaf");
  assert.equal(bent({ snapshot: "10:def" }), false, "a different point in history");
  const [first, ...rest] = proof.path;
  assert.ok(first);
  assert.equal(bent({ path: [{ ...first, sum: first.sum - 1n }, ...rest] }), false, "shrunk sibling sum");
  assert.equal(bent({ path: [{ ...first, sum: -5n }, ...rest] }), false, "negative sibling sum");
  assert.equal(bent({ root: { ...proof.root, sum: proof.root.sum - 1n } }), false, "understated total");
});

test("the engine's liability snapshot always equals what the ledger holds, and every user can prove their share", () => {
  const e = makeEngine();
  fund(e, "alice", 10n * ZEC);
  e.creditDeposit({ depositId: "bob-1", user: "bob", amount: 3n * ZEC, mature: false });
  const token = e.create("alice", { name: "P", symbol: "P", metadataURI: "", value: ZEC }).result.token;
  e.buy("bob", token, ZEC);
  e.buy("alice", token, 7n * ZEC); // graduates: ZEC moves to the pool
  e.requestWithdrawal({ withdrawalId: "w1", user: "alice", address: "utest1x", amount: ZEC / 2n, fee: 10_000n });

  const tree = snapshotLiabilities(e);
  const held = -e.ledger.balance(CHAIN, QUOTE) - e.ledger.balance(LOSS, QUOTE);
  assert.equal(tree.root.sum, held);

  const alice = tree.proof("alice") as InclusionProof;
  assert.ok(LiabilityTree.verify(alice));
  assert.equal(alice.leaf.amount, e.balance("alice") + ZEC / 2n, "an in-flight withdrawal is still owed");
  assert.ok(LiabilityTree.verify(tree.proof("bob") as InclusionProof));
  for (const id of Object.values(AGGREGATE)) assert.ok(LiabilityTree.verify(tree.proof(id) as InclusionProof));
  assert.ok((tree.proof(AGGREGATE.pools)?.leaf.amount ?? 0n) > 0n, "graduated liquidity is counted");

  // Settling the withdrawal moves the money out, and the next snapshot owes less.
  e.submitWithdrawals("tx1", ["w1"], 10_000n);
  e.settleWithdrawals("tx1");
  const after = snapshotLiabilities(e);
  assert.equal(after.root.sum, tree.root.sum - ZEC / 2n - 10_000n);
  assert.notEqual(after.snapshot, tree.snapshot);
});

test("withdrawals are capped per account per rolling day; refunds give the allowance back", async () => {
  let now = 0;
  const e = makeEngine();
  const sim = new SimChain();
  const rails = new Rails(e, sim, { ...DEFAULT_POLICY, dailyWithdrawalLimit: 2n * ZEC }, () => now);
  fund(e, "alice", 10n * ZEC);

  // Engine time comes from makeEngine's clock; start the rails clock at the same moment.
  const last = e.chain.records.at(-1)?.body as { ts: number };
  now = last.ts;

  await rails.requestWithdrawal("alice", "utest1destination01", ZEC);
  await rails.requestWithdrawal("alice", "utest1destination01", ZEC / 2n);
  await assert.rejects(rails.requestWithdrawal("alice", "utest1destination01", ZEC), /LimitExceeded/);
  assert.equal(rails.withdrawalAllowance("alice").remaining, ZEC / 2n);

  // A withdrawal that fails gives its share back.
  const [w] = e.withdrawalRecords("requested");
  assert.ok(w);
  e.cancelWithdrawal(w.id);
  assert.equal(rails.withdrawalAllowance("alice").remaining, ZEC + ZEC / 2n);

  // A day later the window has rolled.
  now += 86_400_000 + 60_000;
  assert.equal(rails.withdrawalAllowance("alice").remaining, 2n * ZEC);
});
