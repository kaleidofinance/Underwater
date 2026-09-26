/**
 * A narrated launch on ZEC parameters: deposit, launch, trade the curve,
 * graduate, trade the built-in DEX, withdraw, then prove solvency.
 *
 *   node demo.ts
 */
import { CHAIN, E18, Engine, FEES, HashChain, QUOTE, ZEC_PARAMS, type Receipt } from "./engine/index.ts";

const ZEC = 100_000_000n;
const ZEC_USD = 1_534;

const zec = (z: bigint): string => `${(Number(z) / 1e8).toFixed(4)} ZEC`;
const usd = (z: bigint): string => `$${Math.round((Number(z) / 1e8) * ZEC_USD).toLocaleString("en-US")}`;
const tokens = (t: bigint): string => `${(Number(t / E18) / 1e6).toFixed(2)}M`;

const e = new Engine({
  params: ZEC_PARAMS,
  fees: { tradeFeeBps: 100n, graduationFeeBps: 500n, creationFee: 100_000n },
});

function step(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function state(token: string): string {
  const p = e.pool(token);
  if (!p) return "";
  const where = p.graduated ? "DEX" : `curve ${(Number(e.progressBps(token)) / 100).toFixed(1)}% to graduation`;
  return `FDV ${zec(e.marketCap(token))} (${usd(e.marketCap(token))}) · ${where}`;
}

const show = (r: Receipt<unknown>): string => `  #${r.seq} ${r.hash.slice(0, 12)}…`;

step("Deposits land (the rails credit these from Zcash confirmations)");
for (const [user, amount] of [["alice", 2n], ["bob", 3n], ["carol", 3n], ["whale", 10n]] as const) {
  e.creditDeposit({ depositId: `demo-${user}`, user, amount: amount * ZEC, mature: true });
  console.log(`  ${user.padEnd(6)} +${zec(amount * ZEC)}`);
}

step("alice launches $PEPE with a 0.2 ZEC first buy");
const launch = e.create("alice", {
  name: "Pepe on Zcash",
  symbol: "PEPE",
  metadataURI: "ipfs://pepe",
  value: 100_000n + ZEC / 5n,
});
const PEPE = launch.result.token;
console.log(`  ${PEPE}: alice holds ${tokens(e.balance("alice", PEPE))} PEPE`);
console.log(`  ${state(PEPE)}`);
console.log(show(launch));

step("The curve trades");
const b = e.buy("bob", PEPE, ZEC);
console.log(`  bob   buys  1.0000 ZEC → ${tokens(b.result)} PEPE      ${state(PEPE)}`);
const c = e.buy("carol", PEPE, ZEC / 2n);
console.log(`  carol buys  0.5000 ZEC → ${tokens(c.result)} PEPE      ${state(PEPE)}`);
const s = e.sell("bob", PEPE, b.result / 2n);
console.log(`  bob   sells ${tokens(b.result / 2n)} PEPE → ${zec(s.result)}   ${state(PEPE)}`);

step("whale sends 6 ZEC: the buy stops exactly at 6 ZEC raised and graduates");
const before = e.balance("whale");
const w = e.buy("whale", PEPE, 6n * ZEC);
const grad = w.events.find((ev) => ev.type === "Graduated");
console.log(`  charged ${zec(before - e.balance("whale"))} of 6 ZEC sent; the rest never left the whale`);
if (grad?.type === "Graduated") {
  console.log(`  pool seeded: ${zec(grad.quoteLiquidity)} + ${tokens(grad.tokenLiquidity)} PEPE, protocol cut ${zec(grad.protocolFee)}`);
  console.log(`  unsold curve tokens burned: ${grad.unsoldBurned} base units`);
}
console.log(`  ${state(PEPE)}`);

step("Trading moves to the built-in DEX, instantly");
const d1 = e.swapQuoteForTokens("carol", PEPE, ZEC / 2n);
console.log(`  carol buys  0.5000 ZEC → ${tokens(d1.result)} PEPE      ${state(PEPE)}`);
const bobPepe = e.balance("bob", PEPE);
const d2 = e.swapTokensForQuote("bob", PEPE, bobPepe);
console.log(`  bob   sells ${tokens(bobPepe)} PEPE → ${zec(d2.result)}   ${state(PEPE)}`);

step("alice cashes out");
const WITHDRAWAL_FEE = 10_000n; // 0.0001 ZEC, covers the ZIP-317 network fee
const aliceZec = e.balance("alice") - WITHDRAWAL_FEE;
e.requestWithdrawal({ withdrawalId: "w-alice", user: "alice", address: "utest1alice", amount: aliceZec, fee: WITHDRAWAL_FEE });
e.submitWithdrawals("demo-txid", ["w-alice"], WITHDRAWAL_FEE); // recorded before broadcast
e.settleWithdrawals("demo-txid"); // confirmed on-chain
console.log(`  alice withdraws ${zec(aliceZec)} (and still holds ${tokens(e.balance("alice", PEPE))} PEPE)`);

step("Balances");
for (const user of ["alice", "bob", "carol", "whale"]) {
  console.log(`  ${user.padEnd(6)} ${zec(e.balance(user)).padStart(12)}   ${tokens(e.balance(user, PEPE)).padStart(8)} PEPE`);
}
console.log(`  protocol revenue: ${zec(e.ledger.balance(FEES, QUOTE))} (${usd(e.ledger.balance(FEES, QUOTE))})`);

step("Solvency");
e.ledger.verify();
const owed = -e.ledger.balance(CHAIN, QUOTE);
const held = e.ledger.total(QUOTE, (a) => a !== CHAIN && a !== "loss");
console.log(`  ZEC that must sit in reserves: ${zec(owed)}`);
console.log(`  ZEC accounted for inside:      ${zec(held)}  ${owed === held ? "✓ exact" : "✗ MISMATCH"}`);
console.log(`  ledger rebuilt from ${e.ledger.journal.length} journal entries ✓`);
console.log(`  command log: ${e.chain.length} records, head ${e.chain.head.slice(0, 16)}…, verifies: ${HashChain.verify(e.chain.records) ? "✓" : "✗"}`);
