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

export interface AccountTotals {
  /** Everything the account holds, including change and notes still confirming. */
  readonly total: bigint;
  /** What it can spend right now. */
  readonly spendable: bigint;
}

/**
 * The wallet is two accounts. **treasury** owns every deposit address and
 * keeps its viewing key private, because that key would link deposits to
 * users. **reserve** holds the funds and pays withdrawals, and its viewing
 * key is published, so anyone can watch what it holds.
 */
export interface Balances {
  readonly treasury: AccountTotals;
  readonly reserve: AccountTotals;
  /** The cold wallet, watched read-only by its viewing key. Absent until one is configured. */
  readonly cold?: AccountTotals;
}

export interface ReserveInfo {
  /** Unified full viewing key of the reserve. Public by design. */
  readonly ufvk: string;
  readonly address: string;
  /** Scan from here when importing the key. */
  readonly birthday: number;
  /** The cold wallet, when configured: its viewing key is published alongside the reserve's. */
  readonly cold?: { readonly ufvk: string; readonly address: string } | null;
}

export interface ZcashWallet {
  /** Height of the best chain tip. */
  tip(): Promise<number>;
  /** Unified address at diversifier `index` of the treasury account. Deterministic. */
  addressAt(index: number): Promise<string>;
  /** Notes received by the treasury at height >= `fromHeight`, on the current best chain. Never change, never reserve notes. */
  incoming(fromHeight: number): Promise<IncomingNote[]>;
  validateAddress(address: string): Promise<boolean>;
  /** The reserve's confirmed, unspent value not committed to any prepared transaction: what withdrawals can draw on. */
  spendable(): Promise<bigint>;
  balances(): Promise<Balances>;
  reserveInfo(): Promise<ReserveInfo>;
  /** Where funds above the online ceiling go; null until a cold wallet is configured. */
  coldAddress(): Promise<string | null>;
  /** Build and sign one transaction from the reserve paying every output. Doesn't broadcast. */
  prepare(outputs: readonly Output[]): Promise<PreparedTx>;
  /** Build and sign a transaction moving everything the treasury can spend into the reserve; null if there's nothing yet. */
  sweep(): Promise<PreparedTx | null>;
  /** Build and sign a reserve self-payment carrying `memo` (at most 512 bytes). */
  anchor(memo: string): Promise<PreparedTx>;
  /** Send a prepared transaction. Safe to repeat. */
  broadcast(txid: string): Promise<void>;
  status(txid: string): Promise<TxStatus>;
}
