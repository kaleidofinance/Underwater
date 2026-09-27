/**
 * Double-entry ledger.
 *
 * Every movement of value is a journal entry whose postings sum to zero per
 * asset, so value can only move between accounts, never appear or vanish.
 * That is what lets proof of reserves work later: every liability is a
 * balance here, and the whole system provably nets to zero.
 *
 * Only source accounts may run negative. `chain` is where deposits enter and
 * withdrawals leave, so its negative balance is exactly what we owe against
 * on-chain reserves. `mint:<token>` is where a token's supply is created.
 * `loss` records value the protocol had to cover without the fees to cover
 * it (a reorged deposit that was already spent, say), so an unbacked
 * liability is always visible as a number rather than hidden.
 */
import { fail } from "./errors.ts";

export type AccountId = string;
export type AssetId = string;

/** The quote asset: ZEC in production, ETH in the parity harness. */
export const QUOTE: AssetId = "QUOTE";

export interface Posting {
  readonly account: AccountId;
  readonly asset: AssetId;
  /** Positive credits the account, negative debits it. */
  readonly amount: bigint;
}

export interface JournalEntry {
  readonly id: number;
  readonly memo: string;
  readonly postings: readonly Posting[];
}

const SEP = "|";

function key(account: AccountId, asset: AssetId): string {
  return account + SEP + asset;
}

function split(k: string): [AccountId, AssetId] {
  const i = k.lastIndexOf(SEP);
  return [k.slice(0, i), k.slice(i + 1)];
}

export function isSourceAccount(account: AccountId): boolean {
  return account === "chain" || account === "loss" || account.startsWith("mint:");
}

export class Ledger {
  #balances = new Map<string, bigint>();
  #journal: JournalEntry[] = [];
  #undo: Map<string, bigint> | null = null;
  #mark = 0;

  balance(account: AccountId, asset: AssetId): bigint {
    return this.#balances.get(key(account, asset)) ?? 0n;
  }

  get journal(): readonly JournalEntry[] {
    return this.#journal;
  }

  /** Every non-zero balance, as [account, asset, amount]. */
  *balances(): IterableIterator<[AccountId, AssetId, bigint]> {
    for (const [k, amount] of this.#balances) {
      const [account, asset] = split(k);
      yield [account, asset, amount];
    }
  }

  /** Sum of one asset across every account matching `predicate`. */
  total(asset: AssetId, predicate: (account: AccountId) => boolean = () => true): bigint {
    let sum = 0n;
    for (const [account, a, amount] of this.balances()) {
      if (a === asset && predicate(account)) sum += amount;
    }
    return sum;
  }

  /**
   * Move `amount` of `asset` between two accounts. A zero amount is a no-op,
   * as a zero-value transfer is in the contracts.
   */
  transfer(memo: string, from: AccountId, to: AccountId, asset: AssetId, amount: bigint): void {
    if (amount < 0n) fail("InvariantViolation", "negative transfer");
    if (amount === 0n) return;
    this.post(memo, [
      { account: from, asset, amount: -amount },
      { account: to, asset, amount },
    ]);
  }

  post(memo: string, postings: readonly Posting[]): void {
    for (const p of postings) {
      if (p.account.includes(SEP) || p.asset.includes(SEP)) fail("InvalidArgument", `"${SEP}" is reserved`);
    }

    const sums = new Map<AssetId, bigint>();
    for (const p of postings) sums.set(p.asset, (sums.get(p.asset) ?? 0n) + p.amount);
    for (const [asset, sum] of sums) {
      if (sum !== 0n) fail("InvariantViolation", `entry "${memo}" does not balance for ${asset}`);
    }

    // Work out every resulting balance before touching any, so a rejected
    // entry leaves nothing half-applied.
    const next = new Map<string, bigint>();
    for (const p of postings) {
      const k = key(p.account, p.asset);
      next.set(k, (next.get(k) ?? this.#balances.get(k) ?? 0n) + p.amount);
    }
    for (const [k, value] of next) {
      if (value < 0n && !isSourceAccount(split(k)[0])) fail("InsufficientFunds", k);
    }

    for (const [k, value] of next) {
      if (this.#undo && !this.#undo.has(k)) this.#undo.set(k, this.#balances.get(k) ?? 0n);
      if (value === 0n) this.#balances.delete(k);
      else this.#balances.set(k, value);
    }
    this.#journal.push({ id: this.#journal.length, memo, postings: postings.map((p) => ({ ...p })) });
  }

  // ─── Transactions ───────────────────────────────────────────────────────

  begin(): void {
    if (this.#undo) fail("InvariantViolation", "nested ledger transaction");
    this.#undo = new Map();
    this.#mark = this.#journal.length;
  }

  commit(): void {
    this.#undo = null;
  }

  rollback(): void {
    if (!this.#undo) return;
    for (const [k, value] of this.#undo) {
      if (value === 0n) this.#balances.delete(k);
      else this.#balances.set(k, value);
    }
    this.#journal.length = this.#mark;
    this.#undo = null;
  }

  // ─── Audit ──────────────────────────────────────────────────────────────

  /**
   * Rebuild every balance from the journal alone and require it to match the
   * running totals, then require each asset to net to zero system-wide.
   */
  verify(): void {
    const rebuilt = new Map<string, bigint>();
    for (const entry of this.#journal) {
      for (const p of entry.postings) {
        const k = key(p.account, p.asset);
        rebuilt.set(k, (rebuilt.get(k) ?? 0n) + p.amount);
      }
    }
    for (const [k, value] of rebuilt) {
      if ((this.#balances.get(k) ?? 0n) !== value) fail("InvariantViolation", `balance drift at ${k}`);
    }
    for (const [k, value] of this.#balances) {
      if (rebuilt.get(k) !== value) fail("InvariantViolation", `untracked balance at ${k}`);
      if (value < 0n && !isSourceAccount(split(k)[0])) fail("InvariantViolation", `negative balance at ${k}`);
    }

    const perAsset = new Map<AssetId, bigint>();
    for (const [k, value] of this.#balances) {
      const asset = split(k)[1];
      perAsset.set(asset, (perAsset.get(asset) ?? 0n) + value);
    }
    for (const [asset, sum] of perAsset) {
      if (sum !== 0n) fail("InvariantViolation", `${asset} does not net to zero`);
    }
  }
}
