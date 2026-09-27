/**
 * A deterministic in-memory Zcash, for testing the rails against the events
 * that lose exchanges money: reorgs that drop a deposit, transactions that
 * expire, and crashes between recording a payment and sending it.
 *
 * It models only what the rails can observe through `ZcashWallet`, plus the
 * one thing a test needs to assert on: every payment that actually left the
 * wallet. Like the real wallet it is two accounts. Deposits land in the
 * treasury, sweeps move them into the reserve, and only the reserve pays.
 * Spendability follows librustzcash's default confirmation policy: notes
 * from outside need `untrusted` confirmations, and the wallet's own sweep
 * outputs need `trusted`.
 */
import type {
  AccountTotals,
  Balances,
  IncomingNote,
  Output,
  PreparedTx,
  ReserveInfo,
  TxStatus,
  ZcashWallet,
} from "./wallet.ts";

/** Someone pays one of our deposit addresses (treasury). */
interface IncomingTx {
  readonly kind: "in";
  readonly txid: string;
  readonly addressIndex: number;
  readonly amount: bigint;
}

/** Someone pays the reserve directly: a top-up from cold storage. */
interface TopUpTx {
  readonly kind: "topUp";
  readonly txid: string;
  readonly amount: bigint;
}

/** Reserve pays the world. */
interface OutgoingTx {
  readonly kind: "out";
  readonly txid: string;
  readonly outputs: readonly Output[];
  readonly fee: bigint;
}

/** Treasury moves deposits into the reserve. */
interface SweepTx {
  readonly kind: "sweep";
  readonly txid: string;
  readonly noteIds: readonly string[];
  /** What arrives in the reserve: the notes less the fee. */
  readonly amount: bigint;
  readonly fee: bigint;
}

/** Reserve pays itself, carrying a memo. Only the fee leaves. */
interface AnchorTx {
  readonly kind: "anchor";
  readonly txid: string;
  readonly memo: string;
  readonly fee: bigint;
}

type BuiltTx = OutgoingTx | SweepTx | AnchorTx;
type SimTx = IncomingTx | TopUpTx | BuiltTx;

/** ZIP-317: 5,000 zats per logical action, at least two. `outputs` payments plus change, from one note. */
export const zip317Fee = (outputs: number): bigint => 5_000n * BigInt(Math.max(2, outputs + 1));

/** What an anchor pays the reserve's own address. */
export const ANCHOR_ZATS = 10_000n;

export interface SimDepths {
  /** Confirmations before a note from outside the wallet is spendable. */
  readonly untrusted: number;
  /** Confirmations before the wallet's own outputs (sweeps) are spendable. */
  readonly trusted: number;
}

export class SimChain implements ZcashWallet {
  /** blocks[h] is the list of txs mined at height h. Height 0 is genesis. */
  readonly #blocks: SimTx[][] = [[]];
  #mempool: SimTx[] = [];
  readonly #built = new Map<string, BuiltTx>();
  readonly #expired = new Set<string>();
  #nextTx = 0;
  #failBroadcasts = 0;
  /** Initial reserve float: what the hot wallet holds before any deposit. Spendable at once. */
  readonly #float: bigint;
  readonly #depths: SimDepths;

  constructor(float = 0n, depths: SimDepths = { untrusted: 10, trusted: 3 }) {
    this.#float = float;
    this.#depths = depths;
  }

  // ─── Test controls ──────────────────────────────────────────────────────

  get height(): number {
    return this.#blocks.length - 1;
  }

  /** Someone pays `amount` to our address at `addressIndex`. Lands in the next block. */
  receive(addressIndex: number, amount: bigint): string {
    const txid = `in-${++this.#nextTx}`;
    this.#mempool.push({ kind: "in", txid, addressIndex, amount });
    return `${txid}:orchard:0`;
  }

  /** Someone pays the reserve address directly. Lands in the next block. */
  topUpReserve(amount: bigint): string {
    const txid = `topup-${++this.#nextTx}`;
    this.#mempool.push({ kind: "topUp", txid, amount });
    return txid;
  }

  /** Mine `n` blocks; the first takes everything in the mempool. */
  mine(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.#blocks.push(this.#mempool);
      this.#mempool = [];
    }
  }

  /**
   * Orphan the top `depth` blocks. Their transactions return to the mempool,
   * except `drop`, which a double-spend has made invalid, and which vanish.
   */
  reorg(depth: number, drop: readonly string[] = []): void {
    const orphaned = this.#blocks.splice(this.#blocks.length - depth, depth).flat();
    this.#mempool = [...orphaned.filter((t) => !drop.includes(t.txid)), ...this.#mempool];
  }

  /** The network gives up on a transaction: it leaves the mempool for good. */
  expire(txid: string): void {
    this.#expired.add(txid);
    this.#mempool = this.#mempool.filter((t) => t.txid !== txid);
  }

  /** The next `n` broadcasts throw, as a crash or network error would. */
  failNextBroadcasts(n = 1): void {
    this.#failBroadcasts = n;
  }

  /** Every payment that was mined, i.e. money that actually left. Sweeps and anchors never leave. */
  paidOut(): Output[] {
    return this.#blocks.flat().flatMap((t) => (t.kind === "out" ? t.outputs : []));
  }

  /** Memos of every mined anchor, oldest first. */
  anchors(): string[] {
    return this.#blocks.flat().flatMap((t) => (t.kind === "anchor" ? [t.memo] : []));
  }

  // ─── ZcashWallet ────────────────────────────────────────────────────────

  async tip(): Promise<number> {
    return this.height;
  }

  async addressAt(index: number): Promise<string> {
    return `utest1sim${String(index).padStart(8, "0")}`;
  }

  async incoming(fromHeight: number): Promise<IncomingNote[]> {
    const notes: IncomingNote[] = [];
    for (let h = Math.max(1, fromHeight); h <= this.height; h++) {
      for (const t of this.#blocks[h] ?? []) {
        if (t.kind === "in") {
          notes.push({ id: noteId(t), txid: t.txid, addressIndex: t.addressIndex, amount: t.amount, height: h });
        }
      }
    }
    return notes;
  }

  async validateAddress(address: string): Promise<boolean> {
    return /^utest1[a-z0-9]{8,}$/.test(address);
  }

  async spendable(): Promise<bigint> {
    return this.#reserve().spendable;
  }

  async balances(): Promise<Balances> {
    return { treasury: this.#treasury(), reserve: this.#reserve() };
  }

  async reserveInfo(): Promise<ReserveInfo> {
    return { ufvk: "uviewtest1simreserve", address: "utest1simreserve0", birthday: 0 };
  }

  async prepare(outputs: readonly Output[]): Promise<PreparedTx> {
    const total = outputs.reduce((s, o) => s + o.amount, 0n);
    const fee = zip317Fee(outputs.length);
    if (this.#reserve().spendable < total + fee) throw new Error("insufficient spendable funds");
    return this.#build({ kind: "out", txid: `out-${++this.#nextTx}`, outputs: [...outputs], fee });
  }

  async sweep(): Promise<PreparedTx | null> {
    const notes = this.#sweepable();
    const value = notes.reduce((s, n) => s + n.amount, 0n);
    const fee = 5_000n * BigInt(Math.max(2, notes.length));
    if (value <= fee) return null;
    return this.#build({
      kind: "sweep",
      txid: `sweep-${++this.#nextTx}`,
      noteIds: notes.map(noteId),
      amount: value - fee,
      fee,
    });
  }

  async anchor(memo: string): Promise<PreparedTx> {
    if (new TextEncoder().encode(memo).length > 512) throw new Error("memo over 512 bytes");
    const fee = zip317Fee(1);
    if (this.#reserve().spendable < ANCHOR_ZATS + fee) throw new Error("insufficient spendable funds");
    return this.#build({ kind: "anchor", txid: `anchor-${++this.#nextTx}`, memo, fee });
  }

  async broadcast(txid: string): Promise<void> {
    if (this.#failBroadcasts > 0) {
      this.#failBroadcasts--;
      throw new Error("broadcast failed");
    }
    const tx = this.#built.get(txid);
    if (!tx) throw new Error(`unknown transaction ${txid}`);
    if (this.#expired.has(txid)) return;
    const known = this.#mempool.some((t) => t.txid === txid) || this.#minedAt(txid) !== null;
    if (!known) this.#mempool.push(tx);
  }

  async status(txid: string): Promise<TxStatus> {
    const h = this.#minedAt(txid);
    if (h !== null) return { state: "mined", height: h };
    if (this.#mempool.some((t) => t.txid === txid)) return { state: "mempool" };
    if (this.#expired.has(txid)) return { state: "expired" };
    return { state: "unknown" };
  }

  // ─── Accounts ───────────────────────────────────────────────────────────

  #minedAt(txid: string): number | null {
    for (let h = 1; h <= this.height; h++) {
      if ((this.#blocks[h] ?? []).some((t) => t.txid === txid)) return h;
    }
    return null;
  }

  #confirmations(txid: string): number {
    const h = this.#minedAt(txid);
    return h === null ? 0 : this.height - h + 1;
  }

  #build<T extends BuiltTx>(tx: T): PreparedTx {
    this.#built.set(tx.txid, tx);
    return { txid: tx.txid, fee: tx.fee };
  }

  /** Built transactions that still hold their inputs: anything not expired. */
  #live(): BuiltTx[] {
    return [...this.#built.values()].filter((t) => !this.#expired.has(t.txid));
  }

  #minedDeposits(): IncomingTx[] {
    return this.#blocks.flat().filter((t): t is IncomingTx => t.kind === "in");
  }

  #sweptIds(): Set<string> {
    return new Set(this.#live().flatMap((t) => (t.kind === "sweep" ? t.noteIds : [])));
  }

  #sweepable(): IncomingTx[] {
    const swept = this.#sweptIds();
    return this.#minedDeposits().filter(
      (n) => !swept.has(noteId(n)) && this.#confirmations(n.txid) >= this.#depths.untrusted,
    );
  }

  #treasury(): AccountTotals {
    const swept = this.#sweptIds();
    const total = this.#minedDeposits()
      .filter((n) => !swept.has(noteId(n)))
      .reduce((s, n) => s + n.amount, 0n);
    const spendable = this.#sweepable().reduce((s, n) => s + n.amount, 0n);
    return { total, spendable };
  }

  #reserve(): AccountTotals {
    let total = this.#float;
    let spendable = this.#float;
    for (const t of this.#blocks.flat()) {
      if (t.kind !== "topUp") continue;
      total += t.amount;
      if (this.#confirmations(t.txid) >= this.#depths.untrusted) spendable += t.amount;
    }
    for (const t of this.#live()) {
      if (t.kind === "sweep") {
        total += t.amount;
        if (this.#confirmations(t.txid) >= this.#depths.trusted) spendable += t.amount;
      } else {
        const out = t.kind === "out" ? t.outputs.reduce((s, o) => s + o.amount, 0n) : 0n;
        total -= out + t.fee;
        spendable -= out + t.fee;
      }
    }
    return { total, spendable };
  }
}

const noteId = (t: IncomingTx): string => `${t.txid}:orchard:0`;
