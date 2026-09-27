/**
 * The rails: the loop that moves money between Zcash and the engine.
 *
 *   deposits     scan incoming notes → credit at `creditDepth` (tradable)
 *                → mature at `finalityDepth` (withdrawable) → or reverse, if a
 *                reorg drops the note first
 *   withdrawals  requested → batched into one transaction → recorded in the
 *                engine's log → broadcast → settled at `finalityDepth`, or
 *                refunded if the transaction expires
 *
 * Every decision is recorded in the engine's durable log, never kept only in
 * memory, so a restart resumes exactly where it stopped. The one ordering
 * that matters is that a withdrawal transaction is recorded *before* it is
 * broadcast. A crash between the two leaves a recorded transaction that
 * `tick` rebroadcasts, never a payment the ledger doesn't know about.
 *
 * Idempotent throughout. A deposit's id is its note id, so rescanning the
 * same blocks any number of times credits each note once.
 */
import { randomUUID } from "node:crypto";
import {
  CHAIN,
  Engine,
  EngineError,
  QUOTE,
  ZATS_PER_ZEC,
  type DepositRecord,
  type TreasuryTxPurpose,
  type UserId,
} from "../engine/index.ts";
import type { AccountTotals, ZcashWallet } from "./wallet.ts";

export interface RailsPolicy {
  /** Confirmations before a deposit is credited, and tradable. */
  readonly creditDepth: number;
  /** Confirmations before a deposit is final and withdrawable: the reorg depth we defend against. */
  readonly finalityDepth: number;
  /**
   * Deposits above this skip fast credit and wait for `finalityDepth`. It is
   * the most a double-spender can move to other users before a reorg claws it
   * back (see Engine.reverseDeposit).
   */
  readonly fastCreditCap: bigint;
  /** Notes below this cost more to spend than they're worth: reported, not credited. */
  readonly minDeposit: bigint;
  readonly minWithdrawal: bigint;
  /** Flat fee per withdrawal. Must cover its share of a batch's network fee. */
  readonly withdrawalFee: bigint;
  /** Outputs per withdrawal transaction. */
  readonly maxBatch: number;
  /** Blocks rescanned every tick. Must exceed `finalityDepth`, so every immature deposit is rechecked. */
  readonly scanWindow: number;
  /** Treasury wallet birthday: the first tick after a start rescans from here, catching anything missed while down. */
  readonly birthday: number;
  /**
   * Most one account can withdraw in any rolling 24 hours. A stolen key or
   * a bug can then only drain this much per account per day, which buys
   * time to notice.
   */
  readonly dailyWithdrawalLimit: bigint;
  /**
   * Sweep the treasury into the reserve once this much is spendable there.
   * Each swept note costs 5,000 zats of network fee, paid by the protocol,
   * so sweeping in bulk is cheaper. Withdrawals are paid only from the
   * reserve, so this is also how long deposits wait before they can leave.
   */
  readonly sweepMin: bigint;
  /** Write the log's head into a reserve memo at most this often (ms), when it has moved. 0 turns anchoring off. */
  readonly anchorEveryMs: number;
}

export const DEFAULT_POLICY: RailsPolicy = Object.freeze({
  creditDepth: 3, // ~4 min
  finalityDepth: 10, // ~12.5 min
  fastCreditCap: 5n * ZATS_PER_ZEC,
  // 0.001 ZEC. Sweeping a note into the reserve costs the protocol 5,000 zats,
  // so at the old 10,000 a stream of tiny deposits cost us half their value.
  minDeposit: 100_000n,
  minWithdrawal: 100_000n,
  withdrawalFee: 10_000n, // covers a single-output ZIP-317 fee
  maxBatch: 50,
  scanWindow: 20,
  birthday: 0,
  dailyWithdrawalLimit: 50n * ZATS_PER_ZEC,
  sweepMin: 1_000_000n, // 0.01 ZEC
  anchorEveryMs: 3_600_000, // hourly: ~0.0024 ZEC a day in fees
});

/** An anchor spends a 10,000-zat self-payment plus a two-action fee. */
const ANCHOR_MIN_RESERVE = 20_000n;

/** The memo an anchor carries: the log's length and head hash when it was written. */
export const anchorMemo = (length: number, head: string): string => `uwzec:anchor:v1:${length}:${head}`;

export function parseAnchorMemo(memo: string): { length: number; head: string } | null {
  const m = /^uwzec:anchor:v1:(\d+):([0-9a-f]{64})$/.exec(memo);
  return m ? { length: Number(m[1]), head: m[2] ?? "" } : null;
}

export interface Reconciliation {
  /** What the ledger says the wallet should hold, net of what in-flight transactions have committed. */
  readonly expected: bigint;
  /** What the treasury and reserve accounts hold together. */
  readonly actual: bigint;
  readonly drift: bigint;
  readonly treasury: AccountTotals;
  readonly reserve: AccountTotals;
  /**
   * Transactions built but not yet final. Their outputs may not be counted
   * by the wallet yet, so negative drift only means ZEC is missing when this is 0.
   */
  readonly inFlight: number;
}

export interface TickReport {
  readonly tip: number;
  readonly credited: string[];
  readonly matured: string[];
  readonly reversed: string[];
  /** Notes below `minDeposit`. */
  readonly ignored: string[];
  readonly submitted: string[];
  readonly rebroadcast: string[];
  readonly settled: string[];
  readonly failed: string[];
  /** Sweep transactions built this tick. */
  readonly swept: string[];
  /** Anchor transactions built this tick. */
  readonly anchored: string[];
  /** Sweeps and anchors that reached finality this tick. */
  readonly treasurySettled: string[];
  /** Things a human should look at. */
  readonly alerts: string[];
}

export class Rails {
  readonly engine: Engine;
  readonly wallet: ZcashWallet;
  readonly policy: RailsPolicy;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  /** Tip at the last completed deposit scan; null until the first, which rescans from `birthday`. */
  #lastTip: number | null = null;

  constructor(engine: Engine, wallet: ZcashWallet, policy: RailsPolicy = DEFAULT_POLICY, now: () => number = Date.now) {
    if (policy.scanWindow <= policy.finalityDepth) {
      throw new EngineError("InvalidConfig", "scanWindow must exceed finalityDepth");
    }
    if (policy.creditDepth < 1 || policy.creditDepth > policy.finalityDepth) {
      throw new EngineError("InvalidConfig", "creditDepth must be between 1 and finalityDepth");
    }
    this.engine = engine;
    this.wallet = wallet;
    this.policy = policy;
    this.#now = now;
  }

  /** The user's rolling 24-hour withdrawal allowance: what's been used and what's left. */
  withdrawalAllowance(user: UserId): { limit: bigint; used: bigint; remaining: bigint } {
    const since = this.#now() - 86_400_000;
    const used = this.engine
      .withdrawalRecords()
      .filter((w) => w.user === user && w.requestedAt >= since && w.state !== "failed" && w.state !== "cancelled")
      .reduce((s, w) => s + w.amount, 0n);
    const limit = this.policy.dailyWithdrawalLimit;
    return { limit, used, remaining: used >= limit ? 0n : limit - used };
  }

  /** The user's deposit address, assigning the next diversifier index the first time. */
  depositAddress(user: UserId): Promise<string> {
    return this.#exclusive(async () => {
      const existing = this.engine.addressOf(user);
      if (existing) return existing.address;
      const index = this.engine.nextAddressIndex;
      const address = await this.wallet.addressAt(index);
      this.engine.assignAddress(user, index, address);
      return address;
    });
  }

  /** Queue a withdrawal. The amount and fee leave the user's balance now; the ZEC leaves on the next tick. */
  requestWithdrawal(user: UserId, address: string, amount: bigint): Promise<string> {
    return this.#exclusive(async () => {
      if (!(await this.wallet.validateAddress(address))) throw new EngineError("InvalidArgument", "not a valid Zcash address");
      if (amount < this.policy.minWithdrawal) throw new EngineError("InvalidArgument", `minimum withdrawal is ${this.policy.minWithdrawal}`);
      const { remaining } = this.withdrawalAllowance(user);
      if (amount > remaining) throw new EngineError("LimitExceeded", `daily withdrawal limit: ${remaining} zats left today`);
      const withdrawalId = randomUUID();
      this.engine.requestWithdrawal({ withdrawalId, user, address, amount, fee: this.policy.withdrawalFee });
      return withdrawalId;
    });
  }

  /** One pass: deposits, then in-flight withdrawals, then new ones. Run it every block (~75 s) or faster. */
  tick(): Promise<TickReport> {
    return this.#exclusive(async () => {
      const tip = await this.wallet.tip();
      const report: TickReport = {
        tip,
        credited: [],
        matured: [],
        reversed: [],
        ignored: [],
        submitted: [],
        rebroadcast: [],
        settled: [],
        failed: [],
        swept: [],
        anchored: [],
        treasurySettled: [],
        alerts: [],
      };
      await this.#deposits(tip, report);
      await this.#inFlight(tip, report);
      await this.#treasuryInFlight(tip, report);
      await this.#sweep(report);
      await this.#send(report);
      await this.#anchor(report);
      return report;
    });
  }

  /**
   * Compare what the wallet holds, across both accounts, with what the
   * ledger says it should. `expected` is what came in net of what went out,
   * less what submitted transactions have already committed. Positive drift
   * is dust, payments to unassigned addresses, and top-ups. Negative drift
   * with nothing in flight means ZEC is missing.
   */
  async reconcile(): Promise<Reconciliation> {
    let committed = 0n;
    const seen = new Set<string>();
    for (const w of this.engine.withdrawalRecords("submitted")) {
      committed += w.amount;
      if (w.txid && !seen.has(w.txid)) {
        seen.add(w.txid);
        committed += this.engine.batch(w.txid)?.networkFee ?? 0n;
      }
    }
    const treasuryTxs = this.engine.treasuryTxs("submitted");
    for (const t of treasuryTxs) committed += t.networkFee;
    const expected = -this.engine.ledger.balance(CHAIN, QUOTE) - committed;
    const { treasury, reserve } = await this.wallet.balances();
    const actual = treasury.total + reserve.total;
    return { expected, actual, drift: actual - expected, treasury, reserve, inFlight: seen.size + treasuryTxs.length };
  }

  // ─── Deposits ───────────────────────────────────────────────────────────

  async #deposits(tip: number, report: TickReport): Promise<void> {
    const P = this.policy;
    // Scan back from the last tip we processed, not the current one, so a
    // stall longer than the window (wallet service down, say) can't skip
    // blocks. The first scan after a start covers everything since birthday.
    const from = this.#lastTip === null ? P.birthday : Math.max(0, Math.min(tip, this.#lastTip) - P.scanWindow + 1);
    const notes = await this.wallet.incoming(from);
    const onChain = new Set(notes.map((n) => n.id));

    // Reorgs first. An immature credit whose note has left the best chain is
    // undone. Immature credits are younger than finalityDepth < scanWindow,
    // so a note that is still there is always inside what we just scanned.
    for (const d of this.engine.depositRecords()) {
      if (d.mature || d.reversed || onChain.has(noteIdOf(d.id))) continue;
      this.engine.reverseDeposit(d.id);
      report.reversed.push(d.id);
      report.alerts.push(`reorg dropped deposit ${d.id}: ${d.amount} zats reversed for ${d.user}`);
    }

    for (const note of notes) {
      const owner = this.engine.ownerOfIndex(note.addressIndex);
      if (owner === undefined) {
        report.alerts.push(`note ${note.id} paid unassigned address index ${note.addressIndex}`);
        continue;
      }
      if (note.amount < P.minDeposit) {
        report.ignored.push(note.id);
        continue;
      }
      const confirmations = tip - note.height + 1;
      const current = this.#latestCredit(note.id);

      if (current && !current.reversed) {
        if (!current.mature && confirmations >= P.finalityDepth) {
          this.engine.matureDeposit(current.id);
          report.matured.push(current.id);
        }
        continue;
      }

      // New, or back on the chain after a reorg reversed its first credit.
      const needed = note.amount > P.fastCreditCap ? P.finalityDepth : P.creditDepth;
      if (confirmations < needed) continue;
      const depositId = current ? nextCreditId(note.id, this.engine) : note.id;
      this.engine.creditDeposit({ depositId, user: owner, amount: note.amount, mature: confirmations >= P.finalityDepth });
      report.credited.push(depositId);
    }
    this.#lastTip = tip;
  }

  /** The newest credit for a note: the note id itself, or `id/rN` after N reorg reversals. */
  #latestCredit(noteId: string): DepositRecord | undefined {
    let latest = this.engine.depositRecord(noteId);
    for (let k = 1; latest?.reversed; k++) {
      const next = this.engine.depositRecord(`${noteId}/r${k}`);
      if (!next) break;
      latest = next;
    }
    return latest;
  }

  // ─── Withdrawals ────────────────────────────────────────────────────────

  async #inFlight(tip: number, report: TickReport): Promise<void> {
    const txids = new Set(this.engine.withdrawalRecords("submitted").map((w) => w.txid).filter((t): t is string => !!t));
    for (const txid of txids) {
      const status = await this.wallet.status(txid);
      switch (status.state) {
        case "mined":
          if (tip - status.height + 1 >= this.policy.finalityDepth) {
            this.engine.settleWithdrawals(txid);
            report.settled.push(txid);
          }
          break;
        case "mempool":
          break;
        case "expired":
          // Expired transactions can never be mined (ZIP-203), so refunding can't double-pay.
          this.engine.failWithdrawals(txid);
          report.failed.push(txid);
          report.alerts.push(`withdrawal tx ${txid} expired; refunded`);
          break;
        case "unknown":
          // Recorded but never seen by the network, i.e. a crash or failed send before broadcast. Same tx, so no double pay.
          try {
            await this.wallet.broadcast(txid);
            report.rebroadcast.push(txid);
          } catch (err) {
            report.alerts.push(`rebroadcast of ${txid} failed: ${(err as Error).message}`);
          }
          break;
      }
    }
  }

  async #send(report: TickReport): Promise<void> {
    const queue = this.engine.withdrawalRecords("requested");
    for (let i = 0; i < queue.length; i += this.policy.maxBatch) {
      const batch = queue.slice(i, i + this.policy.maxBatch);
      let prepared;
      try {
        prepared = await this.wallet.prepare(batch.map((w) => ({ address: w.address, amount: w.amount })));
      } catch (err) {
        const total = batch.reduce((s, w) => s + w.amount, 0n);
        report.alerts.push(`could not build a ${total}-zat withdrawal batch: ${(err as Error).message}`);
        return; // leave them queued; later batches would hit the same wall
      }
      // Durable before broadcast.
      this.engine.submitWithdrawals(prepared.txid, batch.map((w) => w.id), prepared.fee);
      report.submitted.push(prepared.txid);
      try {
        await this.wallet.broadcast(prepared.txid);
      } catch (err) {
        report.alerts.push(`broadcast of ${prepared.txid} failed; retrying next tick: ${(err as Error).message}`);
      }
    }
  }

  // ─── Sweeps and anchors ─────────────────────────────────────────────────

  async #treasuryInFlight(tip: number, report: TickReport): Promise<void> {
    for (const t of this.engine.treasuryTxs("submitted")) {
      const status = await this.wallet.status(t.txid);
      switch (status.state) {
        case "mined":
          if (tip - status.height + 1 >= this.policy.finalityDepth) {
            this.engine.settleTreasuryTx(t.txid);
            report.treasurySettled.push(t.txid);
          }
          break;
        case "mempool":
          break;
        case "expired":
          this.engine.failTreasuryTx(t.txid);
          report.alerts.push(`${t.purpose} tx ${t.txid} expired`);
          break;
        case "unknown":
          try {
            await this.wallet.broadcast(t.txid);
            report.rebroadcast.push(t.txid);
          } catch (err) {
            report.alerts.push(`rebroadcast of ${t.purpose} ${t.txid} failed: ${(err as Error).message}`);
          }
          break;
      }
    }
  }

  /**
   * Move what the treasury can spend into the reserve. The wallet never
   * reuses notes a pending transaction already spends, so a new sweep can
   * go out while an earlier one is still confirming.
   */
  async #sweep(report: TickReport): Promise<void> {
    const { treasury } = await this.wallet.balances();
    if (treasury.spendable < this.policy.sweepMin) return;
    let prepared;
    try {
      prepared = await this.wallet.sweep();
    } catch (err) {
      report.alerts.push(`could not build a sweep of ${treasury.spendable} zats: ${(err as Error).message}`);
      return;
    }
    if (!prepared) return;
    await this.#submitTreasury(prepared, "sweep", null, report);
    report.swept.push(prepared.txid);
  }

  /**
   * Publish the log's head in a reserve memo, so anyone with the reserve's
   * viewing key can check later that the log wasn't rewritten. At most once
   * per `anchorEveryMs`, and only when the head has moved.
   */
  async #anchor(report: TickReport): Promise<void> {
    if (this.policy.anchorEveryMs <= 0) return;
    const last = this.engine
      .treasuryTxs()
      .filter((t) => t.purpose === "anchor" && t.state !== "failed")
      .at(-1);
    if (last && this.#now() - last.submittedAt < this.policy.anchorEveryMs) return;
    const { length, head } = this.engine.chain;
    if (length === 0) return;
    const anchored = last?.memo ? parseAnchorMemo(last.memo) : null;
    // Nothing since the last anchor except that anchor's own bookkeeping:
    // anchoring again would only anchor the anchor.
    if (anchored && this.engine.chain.records.slice(anchored.length).every((r) => isAnchorBookkeeping(this.engine, r.body))) return;
    // An empty reserve (before the first sweep confirms) is normal, not an alert.
    if ((await this.wallet.balances()).reserve.spendable < ANCHOR_MIN_RESERVE) return;
    const memo = anchorMemo(length, head);
    let prepared;
    try {
      prepared = await this.wallet.anchor(memo);
    } catch (err) {
      report.alerts.push(`could not build an anchor: ${(err as Error).message}`);
      return;
    }
    await this.#submitTreasury(prepared, "anchor", memo, report);
    report.anchored.push(prepared.txid);
  }

  /** Record, then broadcast: the same order as withdrawals, for the same reason. */
  async #submitTreasury(
    prepared: { txid: string; fee: bigint },
    purpose: TreasuryTxPurpose,
    memo: string | null,
    report: TickReport,
  ): Promise<void> {
    this.engine.submitTreasuryTx({ txid: prepared.txid, purpose, networkFee: prepared.fee, memo });
    try {
      await this.wallet.broadcast(prepared.txid);
    } catch (err) {
      report.alerts.push(`broadcast of ${purpose} ${prepared.txid} failed; retrying next tick: ${(err as Error).message}`);
    }
  }

  // ─── Plumbing ───────────────────────────────────────────────────────────

  /** Run `fn` after everything already queued, so ticks and requests never interleave. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

function isAnchorBookkeeping(engine: Engine, body: unknown): boolean {
  const cmd = (body as { command?: { kind?: string; txid?: string } }).command;
  if (!cmd?.txid) return false;
  if (cmd.kind !== "submitTreasuryTx" && cmd.kind !== "settleTreasuryTx" && cmd.kind !== "failTreasuryTx") return false;
  return engine.treasuryTx(cmd.txid)?.purpose === "anchor";
}

/** Strip the `/rN` suffix a re-credit carries. */
export function noteIdOf(depositId: string): string {
  return depositId.replace(/\/r\d+$/, "");
}

function nextCreditId(noteId: string, engine: Engine): string {
  let k = 1;
  while (engine.depositRecord(`${noteId}/r${k}`)) k++;
  return `${noteId}/r${k}`;
}
