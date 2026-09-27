import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  BURN,
  FEES,
  QUOTE,
  ZEC_PARAMS,
  buybackReserveAccount,
  dividendsAccount,
  lpReserveAccount,
  openEngine,
  snapshotLiabilities,
  splitTax,
  validateTax,
  type Engine,
  type EngineEvent,
  type TokenTax,
} from "../engine/index.ts";
import { DEFAULT_FEES, ZEC, assertInvariants, expectError, fund, makeEngine } from "./support.ts";

const USERS = ["alice", "bob", "carol", "dave"];

/** The launch screen's presets. */
const tax = (buy: bigint, sell: bigint, split: Partial<Record<"creatorBps" | "dividendsBps" | "buybackBps" | "liquidityBps", bigint>>): TokenTax => ({
  buyBps: buy,
  sellBps: sell,
  creatorBps: split.creatorBps ?? 0n,
  dividendsBps: split.dividendsBps ?? 0n,
  buybackBps: split.buybackBps ?? 0n,
  liquidityBps: split.liquidityBps ?? 0n,
});
const CREATOR_BACKED = tax(100n, 100n, { creatorBps: 10_000n });
const DIAMOND_HANDS = tax(300n, 300n, { dividendsBps: 10_000n });
const DEFLATIONARY = tax(300n, 300n, { buybackBps: 10_000n });
const AUTO_LP = tax(300n, 300n, { liquidityBps: 10_000n });

const dir = mkdtempSync(join(tmpdir(), "uwzec-tax-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(t: TokenTax | null, creatorBuy = 0n) {
  const e = makeEngine();
  for (const u of USERS) fund(e, u, 20n * ZEC);
  const token = e.create("alice", { name: "T", symbol: "T", metadataURI: "", value: e.fees.creationFee + creatorBuy, tax: t }).result.token;
  return { e, token };
}

const events = (r: { events: readonly EngineEvent[] }, type: EngineEvent["type"]) => r.events.filter((ev) => ev.type === type);

test("a tax is validated: capped at 10% a side, and its split must total 100%", () => {
  expectError("InvalidArgument", () => validateTax(tax(1_001n, 0n, { creatorBps: 10_000n })));
  expectError("InvalidArgument", () => validateTax(tax(100n, 100n, { creatorBps: 5_000n })));
  expectError("InvalidArgument", () => validateTax(tax(100n, 100n, { creatorBps: 6_000n, dividendsBps: 5_000n })));
  assert.equal(validateTax(tax(0n, 0n, { creatorBps: 3n })), null, "a 0% tax is no tax, whatever its split");
  assert.deepEqual(validateTax(DIAMOND_HANDS), DIAMOND_HANDS);
  // Splits never lose or mint a zatoshi.
  const odd = splitTax(tax(100n, 100n, { creatorBps: 3_333n, dividendsBps: 3_333n, buybackBps: 3_334n }), 10n);
  assert.equal(odd.creator + odd.dividends + odd.buyback + odd.liquidity, 10n);
});

test("Creator-backed: the tax goes to the creator, on top of the protocol's unchanged fee", () => {
  const { e, token } = setup(CREATOR_BACKED);
  const alice0 = e.balance("alice");
  const fees0 = e.ledger.balance(FEES, QUOTE);
  const q = e.quoteBuy(token, ZEC);
  const r = e.buy("bob", token, ZEC);
  assert.equal(r.result, q.tokensOut, "fills at the quote");
  assert.equal(q.tax, ZEC / 100n);
  assert.equal(e.balance("alice") - alice0, ZEC / 100n, "1% of the buy to the creator");
  assert.equal(e.ledger.balance(FEES, QUOTE) - fees0, ZEC / 100n, "the protocol's 1% is untouched and all its own");

  const held = e.balance("bob", token);
  const sq = e.quoteSell(token, held);
  const bob0 = e.balance("bob");
  e.sell("bob", token, held, sq.quoteOut);
  assert.equal(e.balance("bob") - bob0, sq.quoteOut, "the seller gets the quote, net of fee and tax");
  assert.equal(e.balance("alice") - alice0, ZEC / 100n + sq.tax);
  assertInvariants(e, USERS);
});

test("Diamond hands: dividends go to holders pro rata, never to the trader paying them, and later buyers don't share earlier ones", () => {
  const { e, token } = setup(DIAMOND_HANDS);
  // First buyer: nobody holds yet, so the dividend half has nowhere to go and waits as liquidity.
  e.buy("bob", token, ZEC);
  assert.equal(e.dividendsOf(token, "bob"), 0n, "no dividends from your own buy");
  assert.ok(e.ledger.balance(lpReserveAccount(token), QUOTE) > 0n);

  // Carol's tax is shared by bob alone.
  const carolTax = (2n * ZEC * 300n) / 10_000n;
  e.buy("carol", token, 2n * ZEC);
  assert.equal(e.dividendsOf(token, "carol"), 0n);
  const bobFromCarol = e.dividendsOf(token, "bob");
  assert.ok(carolTax - bobFromCarol <= 1n, "all of it, less a zatoshi of rounding");

  // Dave's tax is shared by bob and carol in proportion to what they hold.
  e.buy("dave", token, ZEC);
  const bob = e.dividendsOf(token, "bob") - bobFromCarol;
  const carol = e.dividendsOf(token, "carol");
  const ratio = Number(e.balance("bob", token)) / Number(e.balance("carol", token));
  assert.ok(Math.abs(Number(bob) / Number(carol) - ratio) < 1e-6, "pro rata to holdings");
  assert.equal(e.dividendsOf(token, "dave"), 0n);

  // Collecting: explicit, or automatic on the holder's next trade of the token.
  const owed = e.dividendsOf(token, "bob");
  const bob0 = e.balance("bob");
  assert.equal(e.claimDividends("bob", token).result, owed);
  assert.equal(e.balance("bob") - bob0, owed);
  expectError("ZeroAmount", () => e.claimDividends("bob", token));
  const carolOwed = e.dividendsOf(token, "carol");
  const r = e.sell("carol", token, e.balance("carol", token) / 2n);
  assert.deepEqual(events(r, "DividendsPaid"), [{ type: "DividendsPaid", token, user: "carol", amount: carolOwed }]);
  assertInvariants(e, USERS);
  snapshotLiabilities(e); // uncollected dividends are counted in the proof of liabilities
});

test("Deflationary and Auto-LP: curve-phase tax waits for the pool, then burns tokens and deepens liquidity at graduation", () => {
  const split = tax(300n, 300n, { buybackBps: 5_000n, liquidityBps: 5_000n });
  const { e, token } = setup(split);
  e.buy("bob", token, 2n * ZEC);
  const waitingBuyback = e.ledger.balance(buybackReserveAccount(token), QUOTE);
  const waitingLp = e.ledger.balance(lpReserveAccount(token), QUOTE);
  assert.ok(waitingBuyback > 0n && waitingLp > 0n);

  const g = e.buy("carol", token, 8n * ZEC); // graduates
  assert.ok(e.pool(token)?.graduated);
  const burned = events(g, "Buyback")[0] as { quote: bigint; tokensBurned: bigint } | undefined;
  assert.ok(burned && burned.tokensBurned > 0n, "the waiting buyback executed against the new pool");
  assert.ok(e.ledger.balance(BURN, token) > ZEC_PARAMS.curveSupply - (e.pool(token)?.tokensSold ?? 0n), "and burned more than the unsold remainder");
  assert.ok(events(g, "LiquidityAdded").length > 0);
  assertInvariants(e, USERS); // reserves emptied, pool accounts match

  // After graduation, both happen on every pool trade.
  const burn0 = e.ledger.balance(BURN, token);
  const pool0 = e.pool(token)?.amm?.quote ?? 0n;
  const r = e.swapQuoteForTokens("dave", token, ZEC);
  assert.ok(e.ledger.balance(BURN, token) > burn0);
  assert.equal(events(r, "Buyback").length, 1);
  assert.ok((e.pool(token)?.amm?.quote ?? 0n) > pool0);
  const held = e.balance("dave", token);
  const q = e.quoteAmm(token, "sell", held);
  const dave0 = e.balance("dave");
  e.swapTokensForQuote("dave", token, held, q.out);
  assert.equal(e.balance("dave") - dave0, q.out, "a pool sell fills at its quote, tax and all");
  assertInvariants(e, USERS);
});

test("Auto-LP after graduation adds straight to the pool; dividends in the pool are shared like on the curve", () => {
  for (const t of [AUTO_LP, DIAMOND_HANDS]) {
    const { e, token } = setup(t, ZEC); // the creator buys in at launch
    e.buy("bob", token, 8n * ZEC);
    assert.ok(e.pool(token)?.graduated);
    e.swapQuoteForTokens("carol", token, ZEC);
    const held = e.balance("carol", token);
    e.swapTokensForQuote("carol", token, held / 2n);
    assertInvariants(e, USERS);
    if (t === DIAMOND_HANDS) assert.ok(e.dividendsOf(token, "alice") > 0n && e.dividendsOf(token, "bob") > 0n);
    assert.ok(e.ledger.balance(dividendsAccount(token), QUOTE) >= 0n);
  }
});

test("untaxed tokens behave exactly as before: no tax events, no tax accounts", () => {
  const { e, token } = setup(null);
  const r = e.buy("bob", token, ZEC);
  for (const type of ["TaxCollected", "TokenTaxed", "DividendsPaid", "Buyback", "LiquidityAdded"] as const) {
    assert.deepEqual(events(r, type), []);
  }
  assert.equal(e.quoteBuy(token, ZEC).tax, 0n);
  assert.equal(e.ledger.balance(lpReserveAccount(token), QUOTE), 0n);
});

test("a taxed launch survives the durable log: replayed to the same hash, tax and dividends intact", () => {
  const path = join(dir, "taxed.jsonl");
  const a = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  const e: Engine = a.engine;
  for (const u of USERS) fund(e, u, 20n * ZEC);
  const token = e.create("alice", { name: "T", symbol: "T", metadataURI: "", value: ZEC, tax: tax(300n, 300n, { creatorBps: 5_000n, dividendsBps: 5_000n }) }).result.token;
  e.buy("bob", token, ZEC);
  e.buy("carol", token, ZEC);
  const head = e.chain.head;
  const owed = e.dividendsOf(token, "alice");
  a.close();

  const b = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  assert.equal(b.engine.chain.head, head);
  assert.deepEqual(b.engine.pool(token)?.tax, tax(300n, 300n, { creatorBps: 5_000n, dividendsBps: 5_000n }));
  assert.equal(b.engine.dividendsOf(token, "alice"), owed);
  assertInvariants(b.engine, USERS);
  b.close();
});
