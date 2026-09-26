/**
 * The seam between the rails and Zcash.
 *
 * Everything that needs Zcash cryptography lives behind this interface:
 * deriving diversified addresses from the treasury key, trial-decrypting
 * compact blocks to find incoming notes, and building and proving outgoing
 * transactions. That is librustzcash territory. The rails only ever see
 * notes, heights and transaction ids.
 *
 * Implementations:
 *   sim.ts          deterministic in-memory chain, for tests (reorgs, expiries, crashes)
 *   (step 2b)       librustzcash service over lightwalletd, for testnet and mainnet
 */

/** A shielded note received at one of our deposit addresses. */
export interface IncomingNote {
  /** Stable across rescans: `txid:pool:outputIndex`. */
  readonly id: string;
  readonly txid: string;
  /** Diversifier index of the address it was sent to. */
  readonly addressIndex: number;
  /** Zatoshi. */
  readonly amount: bigint;
  /** Height of the block that mined it, on the current best chain. */
  readonly height: number;
}

export interface Output {
  readonly address: string;
  readonly amount: bigint;
}

/** A built, signed, not-yet-broadcast transaction. */
export interface PreparedTx {
  readonly txid: string;
  /** ZIP-317 network fee it pays. */
  readonly fee: bigint;
}

export type TxStatus =
  | { readonly state: "mined"; readonly height: number }
  | { readonly state: "mempool" }
  /** Past its expiry height without being mined: it can never confirm. */
  | { readonly state: "expired" }
  /** Built but never seen by the network (e.g. a crash before broadcast). */
  | { readonly state: "unknown" };

export interface ZcashWallet {
  /** Height of the best chain tip. */
  tip(): Promise<number>;
  /** Unified address at diversifier `index` of the treasury account. Deterministic. */
  addressAt(index: number): Promise<string>;
  /** Notes received at height >= `fromHeight` that are on the current best chain. */
  incoming(fromHeight: number): Promise<IncomingNote[]>;
  validateAddress(address: string): Promise<boolean>;
  /** Confirmed, unspent, not committed to any prepared transaction. */
  spendable(): Promise<bigint>;
  /** Build and sign one transaction paying every output. Doesn't broadcast. */
  prepare(outputs: readonly Output[]): Promise<PreparedTx>;
  /** Send a prepared transaction. Safe to repeat. */
  broadcast(txid: string): Promise<void>;
  status(txid: string): Promise<TxStatus>;
}
