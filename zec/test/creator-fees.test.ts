import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { FEES, QUOTE, ZEC_LAUNCH_FEES, ZEC_PARAMS, openEngine, type Engine, type EngineEvent, type FeeParams } from "../engine/index.ts";
import { DEFAULT_FEES, ZEC, assertInvariants, expectError, fund, makeEngine } from "./support.ts";

const USERS = ["alice", "bob", "carol"];
const HALF = { ...DEFAULT_FEES, creatorShareBps: 5_000n };

const dir = mkdtempSync(join(tmpdir(), "uwzec-creator-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const launch = (e: Engine, user: string): string =>
  e.create(user, { name: "Pepe", symbol: "PEPE", metadataURI: "", value: e.fees.creationFee }).result.token;

const creatorFees = (events: readonly EngineEvent[]) => events.filter((ev) => ev.type === "CreatorFee");

test("half of every curve trade fee goes to the token's creator, the rest to the protocol", () => {
  const e = makeEngine(ZEC_PARAMS, HALF);
  for (const u of USERS) fund(e, u, 5n * ZEC);
  const token = launch(e, "alice");
  const alice0 = e.balance("alice");
  const fees0 = e.ledger.balance(FEES, QUOTE);

  const buy = e.buy("bob", token, ZEC / 2n);
  const buyFee = (ZEC / 2n) / 100n; // 1%
  assert.deepEqual(creatorFees(buy.events), [{ type: "CreatorFee", token, creator: "alice", amount: buyFee / 2n }]);
  assert.equal(e.balance("alice") - alice0, buyFee / 2n);
  assert.equal(e.ledger.balance(FEES, QUOTE) - fees0, buyFee - buyFee / 2n);

  const held = e.balance("bob", token);
  const sell = e.sell("bob", token, held / 2n);
  const sellFee = (sell.events.find((ev) => ev.type === "Trade") as { fee: bigint }).fee;
  assert.equal(creatorFees(sell.events)[0]?.amount, sellFee / 2n);
  assert.equal(e.balance("alice") - alice0, buyFee / 2n + sellFee / 2n, "sells pay the creator too");
  assertInvariants(e, USERS);
});

test("an odd fee rounds in the protocol's favour, and the creator trading their own token pays half back to themself", () => {
  const e = makeEngine(ZEC_PARAMS, HALF);
  fund(e, "alice", 5n * ZEC);
  const token = launch(e, "alice");
  const before = e.balance("alice");
  const fees0 = e.ledger.balance(FEES, QUOTE);
  e.buy("alice", token, 30_100n); // fee 301 zats
  assert.equal(e.ledger.balance(FEES, QUOTE) - fees0, 151n);
  assert.equal(before - e.balance("alice"), 30_100n - 150n, "spent the buy, got the creator half of its fee back");
  assertInvariants(e, ["alice"]);
});

test("no share configured means no creator fees: the EVM parity config and old logs behave exactly as before", () => {
  const e = makeEngine(); // DEFAULT_FEES has no creatorShareBps
  fund(e, "alice", ZEC);
  fund(e, "bob", ZEC);
  const token = launch(e, "alice");
  const alice0 = e.balance("alice");
  const r = e.buy("bob", token, ZEC / 10n);
  assert.deepEqual(creatorFees(r.events), [], "no event at all, so old records hash the same");
  assert.equal(e.balance("alice"), alice0);
});

test("the share is capped at the whole fee and can't go negative", () => {
  const e = makeEngine();
  expectError("InvalidArgument", () => e.setCreatorShareBps(10_001n));
  expectError("InvalidArgument", () => e.setCreatorShareBps(-1n));
  e.setCreatorShareBps(10_000n);
  assert.equal(e.fees.creatorShareBps, 10_000n);
  assert.equal(ZEC_LAUNCH_FEES.creatorShareBps, 0n, "protocol fees are the protocol's; creators earn through their token's tax");
});

test("a log from before creator fees replays unchanged, then switches them on with one logged command", () => {
  const path = join(dir, "engine.jsonl");
  const first = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  fund(first.engine, "alice", ZEC);
  fund(first.engine, "bob", ZEC);
  const token = launch(first.engine, "alice");
  first.engine.buy("bob", token, ZEC / 10n); // before: all of the fee to the protocol
  const aliceBefore = first.engine.balance("alice");
  first.close();

  // What main.ts does on startup when the config's share differs from the log's.
  const second = openEngine(path, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  assert.equal(second.engine.fees.creatorShareBps ?? 0n, 0n, "the log's own header wins over the config");
  assert.equal(second.engine.balance("alice"), aliceBefore, "history is not re-priced");
  second.engine.setCreatorShareBps(5_000n);
  second.engine.buy("bob", token, ZEC / 10n);
  const earned = second.engine.balance("alice") - aliceBefore;
  assert.ok(earned > 0n, "trades after the switch pay the creator");
  const head = second.engine.chain.head;
  second.close();

  const third = openEngine(path, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  assert.equal(third.engine.chain.head, head, "the whole log, switch included, replays to the same hash");
  assert.equal(third.engine.fees.creatorShareBps, 5_000n);
  assert.equal(third.engine.balance("alice") - aliceBefore, earned);
  third.close();
});

// ─── After graduation: the pool fee ─────────────────────────────────────────

const LAUNCH = { ...HALF, ammFeeBps: 50n };

/** A launched and graduated token, with carol funded to trade its pool. */
function graduated(fees: FeeParams = LAUNCH) {
  const e = makeEngine(ZEC_PARAMS, fees);
  for (const u of USERS) fund(e, u, 20n * ZEC);
  const token = launch(e, "alice");
  e.buy("bob", token, 7n * ZEC); // past the 6 ZEC threshold: graduates, the rest refunded
  assert.ok(e.pool(token)?.graduated);
  return { e, token };
}

test("pool trades after graduation pay 0.5%, half of it to the creator", () => {
  const { e, token } = graduated();
  const alice0 = e.balance("alice");
  const fees0 = e.ledger.balance(FEES, QUOTE);
  const pool0 = e.pool(token)?.amm?.quote ?? 0n;

  const quote = e.quoteAmm(token, "buy", ZEC);
  const buy = e.swapQuoteForTokens("carol", token, ZEC, quote.out);
  const fee = ZEC / 200n; // 0.5%
  assert.equal(quote.fee, fee);
  assert.equal(buy.result, quote.out, "fills exactly at the quote");
  assert.equal(e.balance("alice") - alice0, fee / 2n);
  assert.equal(e.ledger.balance(FEES, QUOTE) - fees0, fee - fee / 2n);
  assert.equal((e.pool(token)?.amm?.quote ?? 0n) - pool0, ZEC - fee, "only the net reaches the pair");
  assert.equal(creatorFees(buy.events)[0]?.amount, fee / 2n);

  const held = e.balance("carol", token);
  const sq = e.quoteAmm(token, "sell", held);
  expectError("InsufficientOutputAmount", () => e.swapTokensForQuote("carol", token, held, sq.out + 1n));
  const carol0 = e.balance("carol");
  const sell = e.swapTokensForQuote("carol", token, held, sq.out);
  assert.equal(e.balance("carol") - carol0, sq.out, "the seller gets the quote, net of the fee");
  assert.equal(creatorFees(sell.events)[0]?.amount, sq.fee / 2n);
  assertInvariants(e, USERS);
});

test("with no pool fee set, graduated trading is the plain router swap it always was", () => {
  const { e, token } = graduated(HALF);
  const q = e.quoteAmm(token, "buy", ZEC);
  assert.equal(q.fee, 0n);
  const r = e.swapQuoteForTokens("carol", token, ZEC);
  assert.equal(r.result, q.out);
  assert.deepEqual(creatorFees(r.events), []);
});

test("the pool fee is capped at 2%", () => {
  const e = makeEngine();
  expectError("FeeTooHigh", () => e.setAmmFeeBps(201n));
  expectError("InvalidArgument", () => e.setAmmFeeBps(-1n));
  e.setAmmFeeBps(200n);
  assert.equal(ZEC_LAUNCH_FEES.ammFeeBps, 50n, "the launch config charges 0.5%");
});

test("a log switched on for curve fees takes the pool fee as one more logged command, and replays", () => {
  const path = join(dir, "amm.jsonl");
  const a = openEngine(path, { params: ZEC_PARAMS, fees: DEFAULT_FEES });
  a.engine.setCreatorShareBps(5_000n); // what the live testnet log already holds
  a.close();
  const b = openEngine(path, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  assert.equal(b.engine.fees.ammFeeBps, undefined, "absent, not defaulted: old FeesUpdated events keep their hashes");
  b.engine.setAmmFeeBps(50n);
  const head = b.engine.chain.head;
  b.close();
  const c = openEngine(path, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  assert.equal(c.engine.chain.head, head);
  assert.equal(c.engine.fees.ammFeeBps, 50n);
  c.close();
});
