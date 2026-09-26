import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BPS,
  EVM_PARAMS,
  Engine,
  EngineError,
  FEES,
  HashChain,
  QUOTE,
  ZEC_PARAMS,
  mulDivUp,
  validateCurve,
  type Command,
  type CurveParams,
  type FeeParams,
  type TokenId,
} from "../engine/index.ts";
import { Rng } from "../parity/rng.ts";
import { DEFAULT_FEES, ZEC, assertInvariants, expectError, fund, makeEngine } from "./support.ts";

const launch = (e: Engine, user: string, value = DEFAULT_FEES.creationFee): TokenId =>
  e.create(user, { name: "Pepe", symbol: "PEPE", metadataURI: "ipfs://pepe", value }).result.token;

test("both parameter sets validate, and broken geometry is refused", () => {
  validateCurve(EVM_PARAMS);
  validateCurve(ZEC_PARAMS);
  expectError("InvalidConfig", () => validateCurve({ ...ZEC_PARAMS, graduationQuote: 600_000_001n }));
  expectError("InvalidConfig", () => validateCurve({ ...ZEC_PARAMS, lpSupply: ZEC_PARAMS.lpSupply + 1n }));
  expectError("FeeTooHigh", () => new Engine({ params: ZEC_PARAMS, fees: { ...DEFAULT_FEES, tradeFeeBps: 201n } }));
});

test("ZEC launch geometry matches the spec: 1.5 ZEC FDV at launch, 37.5 ZEC at the end of the curve", () => {
  const e = makeEngine();
  fund(e, "alice", 100n * ZEC);
  const token = launch(e, "alice");
  assert.equal(e.marketCap(token), 150_000_000n);
  // Sub-zatoshi token price survives in priceX18 (0.15 zats per token)...
  assert.equal(e.priceX18(token), 15n * 10n ** 16n);
  // ...where the contract-style view floors it to nothing.
  assert.equal(e.spotPriceE18(token), 0n);

  e.buy("alice", token, 7n * ZEC);
  const p = e.pool(token);
  assert.ok(p?.graduated);
  // The curve's final marginal price, before liquidity moves.
  assert.equal((p.quoteReserve * ZEC_PARAMS.totalSupply) / p.tokenReserve, 3_750_000_000n);
});

test("the graduating buy lands exactly on the threshold and refunds the overshoot", () => {
  const e = makeEngine();
  fund(e, "alice", ZEC);
  fund(e, "whale", 10n * ZEC);
  const token = launch(e, "alice");
  const before = e.balance("whale");
  const feesBefore = e.ledger.balance(FEES, QUOTE);

  const r = e.buy("whale", token, 7n * ZEC);
  const grossNeeded = mulDivUp(6n * ZEC, BPS, BPS - 100n); // 606_060_607
  assert.equal(grossNeeded, 606_060_607n);
  assert.equal(before - e.balance("whale"), grossNeeded, "charged exactly the gross needed; the rest stays");

  const p = e.pool(token);
  assert.ok(p?.graduated && p.amm);
  assert.equal(p.tokensSold, ZEC_PARAMS.curveSupply);
  assert.equal(r.result, ZEC_PARAMS.curveSupply, "the whole curve, in one buy");
  const gradFee = (6n * ZEC * 500n) / BPS;
  assert.equal(p.amm.quote, 6n * ZEC - gradFee);
  assert.equal(p.amm.token, ZEC_PARAMS.lpSupply);
  assert.equal(e.ledger.balance(FEES, QUOTE) - feesBefore, grossNeeded - 6n * ZEC + gradFee);
  assert.deepEqual(
    r.events.map((ev) => ev.type),
    ["Trade", "Graduated"],
  );
  assertInvariants(e, ["alice", "whale"]);
});

test("full lifecycle: launch, trade the curve, graduate, trade the built-in DEX", () => {
  const e = makeEngine();
  for (const u of ["alice", "bob", "whale"]) fund(e, u, 20n * ZEC);
  const token = launch(e, "alice", DEFAULT_FEES.creationFee + ZEC / 10n);
  assert.ok(e.balance("alice", token) > 0n, "creator's first buy filled");

  const bought = e.buy("bob", token, ZEC / 2n).result;
  const got = e.sell("bob", token, bought / 2n).result;
  // Selling back the top half of a buy returns more than half the price
  // (it's the expensive half of a convex curve) but never the whole of it.
  assert.ok(got > 0n && got < ZEC / 2n);
  assertInvariants(e, ["alice", "bob", "whale"]);

  e.buy("whale", token, 10n * ZEC);
  expectError("AlreadyGraduated", () => e.buy("bob", token, ZEC));
  expectError("AlreadyGraduated", () => e.sell("bob", token, 1n));

  const priceBefore = e.priceX18(token);
  const out = e.swapQuoteForTokens("bob", token, ZEC).result;
  assert.ok(out > 0n);
  assert.ok(e.priceX18(token) > priceBefore, "a buy moves the price up");
  const back = e.swapTokensForQuote("bob", token, out).result;
  assert.ok(back < ZEC, "round trip through the pool costs the 0.3% twice");
  assertInvariants(e, ["alice", "bob", "whale"]);
});

test("a rejected command leaves no trace: no token, no fee, no log entry", () => {
  const e = makeEngine();
  fund(e, "alice", ZEC);
  const snapshot = {
    balance: e.balance("alice"),
    fees: e.ledger.balance(FEES, QUOTE),
    journal: e.ledger.journal.length,
    chain: e.chain.length,
    head: e.chain.head,
  };
  // The create itself is fine; its initial buy fails slippage, so all of it reverts.
  expectError("SlippageExceeded", () =>
    e.create("alice", { name: "X", symbol: "X", metadataURI: "", value: ZEC / 10n, minTokensOut: 10n ** 36n }),
  );
  assert.equal(e.tokens.length, 0);
  assert.equal(e.pool("tok_0"), undefined);
  assert.equal(e.balance("alice"), snapshot.balance);
  assert.equal(e.ledger.balance(FEES, QUOTE), snapshot.fees);
  assert.equal(e.ledger.journal.length, snapshot.journal);
  assert.equal(e.chain.length, snapshot.chain);
  assert.equal(e.chain.head, snapshot.head);

  // And the next token still gets the first id.
  assert.equal(launch(e, "alice"), "tok_0");
});

test("errors come out in the contracts' order", () => {
  const e = makeEngine();
  fund(e, "alice", ZEC);
  expectError("InsufficientFunds", () => e.buy("alice", "nope", 2n * ZEC)); // the EVM's own check comes first
  expectError("ZeroAmount", () => e.buy("alice", "nope", 0n)); // msg.value before the pool lookup
  expectError("UnknownToken", () => e.buy("alice", "nope", 1n));
  expectError("ZeroAmount", () => e.sell("alice", "nope", 0n));
  expectError("UnknownToken", () => e.sell("alice", "nope", 1n));
  expectError("EmptyMetadata", () => e.create("alice", { name: "", symbol: "X", metadataURI: "", value: ZEC }));
  expectError("InsufficientCreationFee", () => e.create("alice", { name: "X", symbol: "X", metadataURI: "", value: 1n }));

  const token = launch(e, "alice");
  expectError("NotGraduated", () => e.graduate(token));
  expectError("PairNotFound", () => e.swapQuoteForTokens("alice", token, 1n));
  expectError("InsufficientBalance", () => e.sell("alice", token, 1n)); // more than the curve has sold
  expectError("FeeTooHigh", () => e.setTradeFeeBps(201n));
  expectError("FeeTooHigh", () => e.setCreationFee(ZEC_PARAMS.maxCreationFee + 1n));
  expectError("InvalidArgument", () => e.buy("bad|id", token, 1n));
  expectError("InvalidArgument", () => e.buy("alice", token, -1n));
});

/** Random engine-only activity, including what the parity harness can't send: overdraws, deposits, reorgs and withdrawals. */
function fuzz(
  params: CurveParams,
  seed: number,
  steps: number,
  onStep?: (e: Engine) => void,
): { engine: Engine; users: string[]; fees: FeeParams } {
  const r = new Rng(seed);
  const fees: FeeParams = {
    tradeFeeBps: r.below(params.maxTradeFeeBps),
    graduationFeeBps: r.below(params.maxGraduationFeeBps),
    creationFee: r.below(params.maxCreationFee),
  };
  const e = makeEngine(params, fees);
  const users = ["a", "b", "c", "d"];
  const unit = params.graduationQuote; // one full curve, in this param set's units
  for (const u of users) fund(e, u, 50n * unit);

  const expected = new Set(["InsufficientFunds", "ZeroAmount", "AlreadyGraduated", "SlippageExceeded", "InsufficientBalance",
    "NotGraduated", "InsufficientCreationFee", "PairNotFound", "InsufficientInputAmount", "InsufficientOutputAmount", "FeeTooHigh",
    "ImmatureFunds"]);
  let ids = 0;

  for (let i = 0; i < steps; i++) {
    const u = r.pick(users);
    const tokens = e.tokens;
    const t = tokens.length > 0 ? r.pick(tokens) : "none";
    const held = t === "none" ? 0n : e.balance(u, t);
    const roll = r.next();
    try {
      if (roll < 0.05 || tokens.length === 0) {
        e.create(u, { name: "T", symbol: "T", metadataURI: "", value: e.fees.creationFee + r.below(unit / 4n) });
      } else if (roll < 0.4) {
        e.buy(u, t, r.below(unit / (r.chance(0.1) ? 1n : 20n)), r.chance(0.05) ? 10n ** 40n : 0n);
      } else if (roll < 0.6) {
        e.sell(u, t, r.chance(0.05) ? held + 1n : r.below(held));
      } else if (roll < 0.72) {
        e.swapQuoteForTokens(u, t, r.below(unit / 10n));
      } else if (roll < 0.84) {
        e.swapTokensForQuote(u, t, r.below(held));
      } else if (roll < 0.87) {
        // Withdrawals: request, then batch, then settle or fail.
        const requested = e.withdrawalRecords("requested");
        const submitted = e.withdrawalRecords("submitted");
        const w = r.next();
        if (w < 0.5 || requested.length === 0) {
          e.requestWithdrawal({
            withdrawalId: `w${++ids}`,
            user: u,
            address: `addr-${u}`,
            amount: r.below(e.balance(u) + unit / 10n),
            fee: r.below(unit / 1000n),
          });
        } else if (w < 0.7) {
          const batch = requested.slice(0, 1 + r.int(requested.length)).map((x) => x.id);
          e.submitWithdrawals(`tx${++ids}`, batch, r.below(unit / 500n));
        } else if (w < 0.8) {
          e.cancelWithdrawal(r.pick(requested).id);
        } else if (submitted.length > 0) {
          const txid = r.pick(submitted).txid ?? "";
          if (r.chance(0.75)) e.settleWithdrawals(txid);
          else e.failWithdrawals(txid);
        }
      } else if (roll < 0.93) {
        // Deposits: credit (sometimes immature), then mature or reorg away.
        const pending = e.depositRecords().filter((d) => !d.mature && !d.reversed);
        const d = r.next();
        if (d < 0.6 || pending.length === 0) {
          e.creditDeposit({ depositId: `d${++ids}`, user: u, amount: 1n + r.below(unit), mature: r.chance(0.3) });
        } else if (d < 0.85) {
          e.matureDeposit(r.pick(pending).id);
        } else {
          e.reverseDeposit(r.pick(pending).id);
        }
      } else if (roll < 0.96) {
        e.setTradeFeeBps(r.below(params.maxTradeFeeBps + 5n));
      } else {
        e.graduate(t);
      }
    } catch (err) {
      if (!(err instanceof EngineError) || !expected.has(err.code)) throw err;
    }
    onStep?.(e);
  }
  return { engine: e, users, fees };
}

test("conservation invariants hold after every step of random trading (ZEC and EVM parameters)", () => {
  for (const [params, seed] of [[ZEC_PARAMS, 1], [ZEC_PARAMS, 2], [EVM_PARAMS, 3], [EVM_PARAMS, 4]] as const) {
    const users = ["a", "b", "c", "d"];
    const { engine } = fuzz(params, seed, 600, (e) => assertInvariants(e, users));
    assert.ok(engine.tokens.some((t) => engine.pool(t)?.graduated), `seed ${seed}: fuzz should reach a graduation`);
  }
});

test("the command log is tamper-evident and replays to the identical state", () => {
  const { engine: a, users, fees } = fuzz(ZEC_PARAMS, 9, 400);
  const records = a.chain.records;
  assert.ok(HashChain.verify(records));

  // Replay every accepted command into a fresh engine on the recorded clock.
  const bodies = records.map((r) => r.body as { ts: number; command: Command });
  let i = 0;
  const b = new Engine({ params: a.params, fees, clock: () => bodies[i]?.ts ?? 0 });
  for (; i < bodies.length; i++) {
    const body = bodies[i];
    assert.ok(body);
    b.execute(body.command);
  }
  assert.equal(b.chain.head, a.chain.head, "same commands, same head hash");
  for (const u of users) assert.equal(b.balance(u), a.balance(u));
  assert.deepEqual(b.tokens, a.tokens);

  // Alter one committed amount and the chain no longer verifies.
  const forged = records.map((r, j) => (j === 5 ? { ...r, body: { ...(r.body as object), ts: 0 } } : r));
  assert.equal(HashChain.verify(forged), false);
});

