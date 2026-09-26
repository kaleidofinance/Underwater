/**
 * A deterministic in-memory Zcash, for testing the rails against the events
 * that lose exchanges money: reorgs that drop a deposit, transactions that
 * expire, and crashes between recording a payment and sending it.
 *
 * It models only what the rails can observe through `ZcashWallet`, plus the
 * one thing a test needs to assert on: every payment that actually left the
 * wallet.
 */
import type { IncomingNote, Output, PreparedTx, TxStatus, ZcashWallet } from "./wallet.ts";

interface IncomingTx {
  readonly kind: "in";
  readonly txid: string;
  readonly addressIndex: number;
  readonly amount: bigint;
}

interface OutgoingTx {
  readonly kind: "out";
  readonly txid: string;
  readonly outputs: readonly Output[];
  readonly fee: bigint;
}

type SimTx = IncomingTx | OutgoingTx;

/** ZIP-317: 5,000 zats per logical action, at least two. */
export const zip317Fee = (outputs: number): bigint => 5_000n * BigInt(Math.max(2, outputs + 1));

export class SimChain implements ZcashWallet {
  /** blocks[h] is the list of txs mined at height h. Height 0 is genesis. */
  readonly #blocks: SimTx[][] = [[]];
  #mempool: SimTx[] = [];
  readonly #prepared = new Map<string, OutgoingTx>();
  readonly #expired = new Set<string>();
  #nextTx = 0;
  #failBroadcasts = 0;
  /** Initial treasury float: what the hot wallet holds before any deposit. */
  #float: bigint;

  constructor(float = 0n) {
    this.#float = float;
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

  /** Every payment that was mined, i.e. money that actually left. */
  paidOut(): Output[] {
    return this.#blocks.flat().flatMap((t) => (t.kind === "out" ? t.outputs : []));
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
          notes.push({ id: `${t.txid}:orchard:0`, txid: t.txid, addressIndex: t.addressIndex, amount: t.amount, height: h });
        }
      }
    }
    return notes;
  }

  async validateAddress(address: string): Promise<boolean> {
    return /^utest1[a-z0-9]{8,}$/.test(address);
  }

  async spendable(): Promise<bigint> {
    let balance = this.#float;
    for (const t of this.#blocks.flat()) if (t.kind === "in") balance += t.amount;
    // Anything built and not expired has its inputs committed.
    for (const t of this.#prepared.values()) {
      if (!this.#expired.has(t.txid)) balance -= t.outputs.reduce((s, o) => s + o.amount, 0n) + t.fee;
    }
    return balance;
  }

  async prepare(outputs: readonly Output[]): Promise<PreparedTx> {
    const total = outputs.reduce((s, o) => s + o.amount, 0n);
    const fee = zip317Fee(outputs.length);
    if ((await this.spendable()) < total + fee) throw new Error("insufficient spendable funds");
    const txid = `out-${++this.#nextTx}`;
    this.#prepared.set(txid, { kind: "out", txid, outputs: [...outputs], fee });
    return { txid, fee };
  }

  async broadcast(txid: string): Promise<void> {
    if (this.#failBroadcasts > 0) {
      this.#failBroadcasts--;
      throw new Error("broadcast failed");
    }
    const tx = this.#prepared.get(txid);
    if (!tx) throw new Error(`unknown transaction ${txid}`);
    if (this.#expired.has(txid)) return;
    const known = this.#mempool.some((t) => t.txid === txid) || this.#blocks.some((b) => b.some((t) => t.txid === txid));
    if (!known) this.#mempool.push(tx);
  }

  async status(txid: string): Promise<TxStatus> {
    for (let h = 1; h <= this.height; h++) {
      if ((this.#blocks[h] ?? []).some((t) => t.txid === txid)) return { state: "mined", height: h };
    }
    if (this.#mempool.some((t) => t.txid === txid)) return { state: "mempool" };
    if (this.#expired.has(txid)) return { state: "expired" };
    return { state: "unknown" };
  }
}
