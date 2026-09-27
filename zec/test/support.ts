import assert from "node:assert/strict";
import {
  BURN,
  CHAIN,
  Engine,
  EngineError,
  FEES,
  LOSS,
  PENDING_WITHDRAWALS,
  QUOTE,
  ZEC_PARAMS,
  ammAccount,
  curveAccount,
  mintAccount,
  userAccount,
  type CurveParams,
  type ErrorName,
  type FeeParams,
  buybackReserveAccount,
  dividendsAccount,
  lpReserveAccount,
} from "../engine/index.ts";

export const ZEC = 100_000_000n;

export const DEFAULT_FEES: FeeParams = { tradeFeeBps: 100n, graduationFeeBps: 500n, creationFee: 100_000n };

/** An engine on a deterministic clock that ticks one second per command. */
export function makeEngine(params: CurveParams = ZEC_PARAMS, fees: FeeParams = DEFAULT_FEES): Engine {
  let t = 1_700_000_000_000;
  return new Engine({ params, fees, clock: () => (t += 1_000) });
}

let fundSeq = 0;

/** Credit a final (mature) deposit, for tests that just need a funded user. */
export function fund(engine: Engine, user: string, amount: bigint): void {
  engine.creditDeposit({ depositId: `fund-${++fundSeq}`, user, amount, mature: true });
}

export function expectError(code: ErrorName, fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EngineError, `expected EngineError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/**
 * Every conservation law the engine must keep, checked from the ledger's
 * point of view against the pools' own bookkeeping.
 */
export function assertInvariants(engine: Engine, users: readonly string[]): void {
  const P = engine.params;
  engine.ledger.verify();

  // Quote: everything held inside the system equals what came in through the
  // chain, less whatever the protocol had to absorb as loss.
  const heldQuote = engine.ledger.total(QUOTE, (a) => a !== CHAIN && a !== LOSS);
  assert.equal(
    heldQuote,
    -engine.ledger.balance(CHAIN, QUOTE) - engine.ledger.balance(LOSS, QUOTE),
    "quote held ≠ deposits net of withdrawals and loss",
  );
  assert.ok(engine.ledger.balance(LOSS, QUOTE) <= 0n, "loss can only accumulate");

  // Custody: the pending-withdrawals account holds exactly the in-flight withdrawals.
  const inFlight = engine
    .withdrawalRecords()
    .filter((w) => w.state === "requested" || w.state === "submitted")
    .reduce((s, w) => s + w.amount, 0n);
  assert.equal(engine.ledger.balance(PENDING_WITHDRAWALS, QUOTE), inFlight, "pending withdrawals drift");

  // Each user's immature balance is exactly their unreversed, unmatured deposits.
  const immature = new Map<string, bigint>();
  for (const d of engine.depositRecords()) {
    if (!d.mature && !d.reversed) immature.set(d.user, (immature.get(d.user) ?? 0n) + d.amount);
  }
  for (const u of new Set([...users, ...immature.keys()])) {
    assert.equal(engine.immatureBalance(u), immature.get(u) ?? 0n, `${u}: immature drift`);
  }

  let curveSum = 0n;
  for (const token of engine.tokens) {
    const p = engine.pool(token);
    assert.ok(p);

    // Dividends: what users hold is what they're shared across, and the
    // dividends account covers every claim on it.
    const held = users.reduce((s, u) => s + engine.ledger.balance(userAccount(u), token), 0n);
    assert.equal(p.userSupply, held, `${token}: userSupply drift`);
    const owed = users.reduce((s, u) => s + engine.dividendsOf(token, u), 0n);
    assert.ok(engine.ledger.balance(dividendsAccount(token), QUOTE) >= owed, `${token}: dividends owed exceed what's held`);

    // Tokens: supply is conserved across users, curve, pool and burns.
    const everywhere =
      users.reduce((s, u) => s + engine.ledger.balance(userAccount(u), token), 0n) +
      engine.ledger.balance(curveAccount(token), token) +
      engine.ledger.balance(ammAccount(token), token) +
      engine.ledger.balance(BURN, token);
    assert.equal(everywhere, P.totalSupply, `${token}: supply not conserved`);
    assert.equal(engine.ledger.balance(mintAccount(token), token), -P.totalSupply);
    assert.equal(engine.totalSupply(token), P.totalSupply - engine.ledger.balance(BURN, token));

    if (!p.graduated) {
      // The curve account holds exactly what the pool says it raised, and every unsold token.
      assert.equal(engine.ledger.balance(curveAccount(token), QUOTE), p.realQuoteRaised, `${token}: curve quote drift`);
      assert.equal(engine.ledger.balance(curveAccount(token), token), P.totalSupply - p.tokensSold, `${token}: curve token drift`);
      // x − real is the virtual reserve, forever.
      assert.equal(p.quoteReserve - p.realQuoteRaised, P.virtualQuoteReserve, `${token}: virtual reserve moved`);
      assert.ok(p.tokenReserve >= P.initialTokenReserve - P.curveSupply, `${token}: below the virtual floor`);
      assert.ok(p.realQuoteRaised < P.graduationQuote, `${token}: at threshold but not graduated`);
      assert.equal(p.amm, null);
      curveSum += p.realQuoteRaised;
    } else {
      assert.equal(p.realQuoteRaised, 0n);
      // Rounding favours the pool, so a curve can reach the quote threshold a
      // few base units short of selling out. `_graduate` burns that remainder.
      assert.ok(p.tokensSold <= P.curveSupply);
      // Buybacks burn on top of the unsold remainder; untaxed tokens burn exactly it.
      const burned = engine.ledger.balance(BURN, token);
      if (p.tax) assert.ok(burned >= P.curveSupply - p.tokensSold, `${token}: unsold not burned`);
      else assert.equal(burned, P.curveSupply - p.tokensSold, `${token}: unsold not burned`);
      assert.equal(engine.ledger.balance(lpReserveAccount(token), QUOTE), 0n, `${token}: liquidity tax stranded after graduation`);
      assert.equal(engine.ledger.balance(buybackReserveAccount(token), QUOTE), 0n, `${token}: buyback tax stranded after graduation`);
      assert.equal(engine.ledger.balance(curveAccount(token), QUOTE), 0n, `${token}: quote left on a closed curve`);
      assert.equal(engine.ledger.balance(curveAccount(token), token), 0n, `${token}: tokens left on a closed curve`);
      assert.ok(p.amm);
      assert.equal(engine.ledger.balance(ammAccount(token), QUOTE), p.amm.quote, `${token}: amm quote drift`);
      assert.equal(engine.ledger.balance(ammAccount(token), token), p.amm.token, `${token}: amm token drift`);
    }
  }
  assert.equal(engine.totalCurveQuote, curveSum, "totalCurveQuote ≠ Σ realQuoteRaised");
  assert.ok(engine.ledger.balance(FEES, QUOTE) >= 0n);
}
