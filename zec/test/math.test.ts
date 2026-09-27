import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVM_PARAMS,
  ZEC_PARAMS,
  getAmountIn,
  getAmountOut,
  mulDivUp,
  quoteInForTokens,
  quoteOut,
  sqrt,
  tokensOut,
} from "../engine/index.ts";
import { Rng } from "../parity/rng.ts";
import { expectError } from "./support.ts";

test("raising the graduation threshold from a fresh curve releases exactly the curve supply", () => {
  for (const P of [EVM_PARAMS, ZEC_PARAMS]) {
    assert.equal(tokensOut(P.virtualQuoteReserve, P.initialTokenReserve, P.graduationQuote), P.curveSupply);
  }
});

test("a curve round trip never pays back more than it took", () => {
  const r = new Rng(7);
  for (let i = 0; i < 2_000; i++) {
    const P = r.chance(0.5) ? EVM_PARAMS : ZEC_PARAMS;
    const raised = r.below(P.graduationQuote - 1n);
    const x = P.virtualQuoteReserve + raised;
    const y = P.initialTokenReserve - tokensOut(P.virtualQuoteReserve, P.initialTokenReserve, raised);
    const quoteIn = 1n + r.below(P.graduationQuote);
    const bought = tokensOut(x, y, quoteIn);
    assert.ok(quoteOut(x + quoteIn, y - bought, bought) <= quoteIn);
  }
});

test("quoteInForTokens is enough to buy what it quotes", () => {
  const r = new Rng(11);
  for (let i = 0; i < 2_000; i++) {
    const x = 1n + r.below(10n ** 20n);
    const y = 1_000n + r.below(10n ** 27n);
    const want = 1n + r.below(y - 2n);
    assert.ok(tokensOut(x, y, quoteInForTokens(x, y, want)) >= want);
  }
  expectError("InsufficientReserve", () => quoteInForTokens(1n, 10n, 10n));
});

test("getAmountOut matches V2 on a hand-worked vector and guards like the library", () => {
  // 1000·997·1000 / (1000·1000 + 1000·997) = 499.2… → 499
  assert.equal(getAmountOut(1_000n, 1_000n, 1_000n), 499n);
  // 1000·499·1000 / ((1000−499)·997) = 999.0… → 999, +1
  assert.equal(getAmountIn(499n, 1_000n, 1_000n), 1_000n);
  expectError("InsufficientInputAmount", () => getAmountOut(0n, 1n, 1n));
  expectError("InsufficientLiquidity", () => getAmountOut(1n, 0n, 1n));
  expectError("InsufficientOutputAmount", () => getAmountIn(0n, 1n, 1n));
  expectError("InsufficientLiquidity", () => getAmountIn(5n, 10n, 5n));
});

test("every getAmountOut fill passes the pair's fee-adjusted k check", () => {
  const r = new Rng(3);
  for (let i = 0; i < 5_000; i++) {
    const rIn = 1n + r.below(10n ** 30n);
    const rOut = 1n + r.below(10n ** 30n);
    const amountIn = 1n + r.below(10n ** 28n);
    const out = getAmountOut(amountIn, rIn, rOut);
    assert.ok(out < rOut);
    const adjustedIn = (rIn + amountIn) * 1000n - amountIn * 3n;
    const adjustedOut = (rOut - out) * 1000n;
    assert.ok(adjustedIn * adjustedOut >= rIn * rOut * 1_000_000n);
    // getAmountIn rounds up, so paying it always buys at least what was asked.
    if (out > 0n) assert.ok(getAmountOut(getAmountIn(out, rIn, rOut), rIn, rOut) >= out);
  }
});

test("mulDivUp rounds up only when the division is inexact", () => {
  assert.equal(mulDivUp(10n, 3n, 3n), 10n);
  assert.equal(mulDivUp(10n, 1n, 3n), 4n);
  assert.equal(mulDivUp(9n, 1n, 3n), 3n);
});

test("sqrt floors", () => {
  for (const [n, s] of [[0n, 0n], [1n, 1n], [2n, 1n], [3n, 1n], [4n, 2n], [15n, 3n], [16n, 4n], [17n, 4n]] as const) {
    assert.equal(sqrt(n), s);
  }
  const r = new Rng(5);
  for (let i = 0; i < 2_000; i++) {
    const n = r.below(10n ** 60n);
    const s = sqrt(n);
    assert.ok(s * s <= n && n < (s + 1n) * (s + 1n));
  }
});
