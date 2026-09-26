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
import { CHAIN, Engine, EngineError, QUOTE, ZATS_PER_ZEC, type DepositRecord, type UserId } from "../engine/index.ts";
import type { ZcashWallet } from "./wallet.ts";

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
}

export const DEFAULT_POLICY: RailsPolicy = Object.freeze({
  creditDepth: 3, // ~4 min
  finalityDepth: 10, // ~12.5 min
  fastCreditCap: 5n * ZATS_PER_ZEC,
  minDeposit: 10_000n,
  minWithdrawal: 100_000n,
  withdrawalFee: 10_000n, // covers a single-output ZIP-317 fee
  maxBatch: 50,
  scanWindow: 20,
  birthday: 0,
  dailyWithdrawalLimit: 50n * ZATS_PER_ZEC,
});

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
        alerts: [],
      };
      await this.#deposits(tip, report);
      await this.#inFlight(tip, report);
      await this.#send(report);
      return report;
    });
  }

  /**
   * Compare what the hot wallet holds with what the ledger says it should.
   * `expected` is what came in net of what went out, less what submitted
   * transactions have already committed. Positive drift is dust and payments
   * to unassigned addresses. Negative drift means ZEC is missing.
   */
  async reconcile(): Promise<{ expected: bigint; actual: bigint; drift: bigint }> {
    let committed = 0n;
    const seen = new Set<string>();
    for (const w of this.engine.withdrawalRecords("submitted")) {
      committed += w.amount;
      if (w.txid && !seen.has(w.txid)) {
        seen.add(w.txid);
        committed += this.engine.batch(w.txid)?.networkFee ?? 0n;
      }
    }
    const expected = -this.engine.ledger.balance(CHAIN, QUOTE) - committed;
    const actual = await this.wallet.spendable();
    return { expected, actual, drift: actual - expected };
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

  // ─── Plumbing ───────────────────────────────────────────────────────────

  /** Run `fn` after everything already queued, so ticks and requests never interleave. */
  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }
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
