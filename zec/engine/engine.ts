/**
 * The Underwater ZEC trading engine: a single-writer state machine that runs
 * the launchpad's bonding curve, graduation and built-in DEX off-chain.
 *
 * Every rule is a port of a deployed contract:
 *
 *   curve math           src/lib/CurveMath.sol
 *   create/buy/sell/grad parity/reference/src/UnderwaterLaunchpad.sol
 *   AMM                  src/dex/UnderwaterPair.sol, libraries/UnderwaterLibrary.sol
 *
 * `parity/run.ts` holds the port to that claim. It replays random trade
 * sequences through both this engine and the contracts, and requires
 * identical balances, reserves and errors after every step.
 *
 * Checks run in the contracts' order, so a rejected command fails with the
 * error the contract would have reverted with. Where Solidity leans on the
 * EVM itself (a sender cannot spend more than it holds), the engine checks at
 * the point the EVM would, with InsufficientFunds.
 *
 * Commands are atomic. A failure rolls back every balance, pool and event it
 * touched, as a revert does, and only accepted commands reach the hash chain.
 */
import { BPS, creatorShare, validateCurve, validateFees, type CurveParams, type FeeParams } from "./config.ts";
import { fail } from "./errors.ts";
import { HashChain, type ChainRecord } from "./hashchain.ts";
import { TxMap } from "./txmap.ts";
import { Ledger, QUOTE, type AccountId, type AssetId } from "./ledger.ts";
import {
  E18,
  MINIMUM_LIQUIDITY,
  U112_MAX,
  getAmountOut,
  mulDivUp,
  quoteOut,
  spotPriceE18,
  sqrt,
  toU128,
  tokensOut,
} from "./math.ts";

export type UserId = string;
export type TokenId = string;

export interface AmmReserves {
  quote: bigint;
  token: bigint;
}

export interface Pool {
  readonly id: TokenId;
  readonly name: string;
  readonly symbol: string;
  readonly metadataURI: string;
  readonly creator: UserId;
  readonly createdAt: number;
  /** Virtual plus real quote on the curve: the `x` term. */
  quoteReserve: bigint;
  /** Virtual token reserve remaining: the `y` term. */
  tokenReserve: bigint;
  /** Real quote held for this curve, net of fees. */
  realQuoteRaised: bigint;
  /** Curve tokens released to buyers so far. */
  tokensSold: bigint;
  graduated: boolean;
  /** The built-in DEX pool, once graduated. */
  amm: AmmReserves | null;
}

export type EngineEvent =
  | { readonly type: "AddressAssigned"; readonly user: UserId; readonly index: number; readonly address: string }
  | {
      readonly type: "DepositCredited";
      readonly depositId: string;
      readonly user: UserId;
      readonly amount: bigint;
      readonly mature: boolean;
    }
  | { readonly type: "DepositMatured"; readonly depositId: string; readonly user: UserId; readonly amount: bigint }
  | {
      readonly type: "DepositReversed";
      readonly depositId: string;
      readonly user: UserId;
      readonly amount: bigint;
      /** Taken back from the user's balance. */
      readonly clawedBack: bigint;
      /** What the user had already spent, covered from protocol fees... */
      readonly coveredByFees: bigint;
      /** ...and past those, recorded as loss. */
      readonly coveredAsLoss: bigint;
    }
  | {
      readonly type: "WithdrawalRequested";
      readonly withdrawalId: string;
      readonly user: UserId;
      readonly address: string;
      readonly amount: bigint;
      readonly fee: bigint;
    }
  | { readonly type: "WithdrawalCancelled"; readonly withdrawalId: string; readonly user: UserId }
  | { readonly type: "WithdrawalsSubmitted"; readonly txid: string; readonly withdrawalIds: readonly string[] }
  | {
      readonly type: "WithdrawalsSettled";
      readonly txid: string;
      readonly withdrawalIds: readonly string[];
      readonly networkFee: bigint;
    }
  | { readonly type: "WithdrawalsFailed"; readonly txid: string; readonly withdrawalIds: readonly string[] }
  /** The creator's share of a trade fee. Emitted only when it's non-zero, so logs from before creator fees replay unchanged. */
  | { readonly type: "CreatorFee"; readonly token: TokenId; readonly creator: UserId; readonly amount: bigint }
  | {
      readonly type: "TreasuryTxSubmitted";
      readonly txid: string;
      readonly purpose: TreasuryTxPurpose;
      readonly networkFee: bigint;
      readonly memo: string | null;
    }
  | { readonly type: "TreasuryTxSettled"; readonly txid: string; readonly purpose: TreasuryTxPurpose; readonly networkFee: bigint }
  | { readonly type: "TreasuryTxFailed"; readonly txid: string; readonly purpose: TreasuryTxPurpose }
  | {
      readonly type: "TokenCreated";
      readonly token: TokenId;
      readonly creator: UserId;
      readonly name: string;
      readonly symbol: string;
      readonly metadataURI: string;
    }
  | {
      readonly type: "Trade";
      readonly venue: "curve" | "amm";
      readonly token: TokenId;
      readonly trader: UserId;
      readonly isBuy: boolean;
      readonly quoteAmount: bigint;
      readonly tokenAmount: bigint;
      readonly fee: bigint;
      readonly quoteReserve: bigint;
      readonly tokenReserve: bigint;
    }
  | {
      readonly type: "Graduated";
      readonly token: TokenId;
      readonly quoteLiquidity: bigint;
      readonly tokenLiquidity: bigint;
      readonly protocolFee: bigint;
      readonly unsoldBurned: bigint;
    }
  | {
      readonly type: "FeesUpdated";
      readonly tradeFeeBps: bigint;
      readonly graduationFeeBps: bigint;
      readonly creationFee: bigint;
    };

export type Command =
  | { readonly kind: "assignAddress"; readonly user: UserId; readonly index: number; readonly address: string }
  | {
      readonly kind: "creditDeposit";
      readonly depositId: string;
      readonly user: UserId;
      readonly amount: bigint;
      readonly mature: boolean;
    }
  | { readonly kind: "matureDeposit" | "reverseDeposit"; readonly depositId: string }
  | {
      readonly kind: "requestWithdrawal";
      readonly withdrawalId: string;
      readonly user: UserId;
      readonly address: string;
      readonly amount: bigint;
      readonly fee: bigint;
    }
  | { readonly kind: "cancelWithdrawal"; readonly withdrawalId: string }
  | {
      readonly kind: "submitWithdrawals";
      readonly txid: string;
      readonly withdrawalIds: readonly string[];
      readonly networkFee: bigint;
    }
  | { readonly kind: "settleWithdrawals" | "failWithdrawals"; readonly txid: string }
  | {
      readonly kind: "submitTreasuryTx";
      readonly txid: string;
      readonly purpose: TreasuryTxPurpose;
      readonly networkFee: bigint;
      readonly memo: string | null;
    }
  | { readonly kind: "settleTreasuryTx" | "failTreasuryTx"; readonly txid: string }
  | {
      readonly kind: "create";
      readonly user: UserId;
      readonly name: string;
      readonly symbol: string;
      readonly metadataURI: string;
      readonly value: bigint;
      readonly minTokensOut: bigint;
    }
  | {
      readonly kind: "buy";
      readonly user: UserId;
      readonly token: TokenId;
      readonly value: bigint;
      readonly minTokensOut: bigint;
    }
  | {
      readonly kind: "sell";
      readonly user: UserId;
      readonly token: TokenId;
      readonly tokenAmount: bigint;
      readonly minQuoteOut: bigint;
    }
  | { readonly kind: "graduate"; readonly token: TokenId }
  | {
      readonly kind: "swapQuoteForTokens" | "swapTokensForQuote";
      readonly user: UserId;
      readonly token: TokenId;
      readonly amountIn: bigint;
      readonly minOut: bigint;
    }
  | { readonly kind: "setTradeFeeBps" | "setGraduationFeeBps"; readonly bps: bigint }
  | { readonly kind: "setCreationFee"; readonly fee: bigint }
  | { readonly kind: "setCreatorShareBps"; readonly bps: bigint };

export interface Receipt<T> {
  readonly seq: number;
  readonly ts: number;
  readonly result: T;
  readonly events: readonly EngineEvent[];
  /** Hash-chain head after this command. */
  readonly hash: string;
}

export interface EngineOptions {
  readonly params: CurveParams;
  readonly fees: FeeParams;
  /** Milliseconds since epoch. Injected so tests and replays are deterministic. */
  readonly clock?: () => number;
  /**
   * Called with each accepted command's record before the command takes
   * effect. Throwing rejects the command. This is where persistence hooks in
   * (see store.ts).
   */
  readonly onCommit?: (record: ChainRecord) => void;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

/** Protocol revenue: the launchpad's `feeRecipient`. */
export const FEES: AccountId = "fees";
/** Where deposits enter and withdrawals leave. Its negative balance is what we owe. */
export const CHAIN: AccountId = "chain";
/** Sink for burned supply. */
export const BURN: AccountId = "burn";
/** Quote debited from users for withdrawals not yet confirmed on-chain. */
export const PENDING_WITHDRAWALS: AccountId = "withdrawals";
/** Unbacked value the protocol absorbed. A source account: negative means lost. */
export const LOSS: AccountId = "loss";

export interface AddressRecord {
  readonly user: UserId;
  /** Diversifier index under the treasury key. */
  readonly index: number;
  readonly address: string;
}

export interface DepositRecord {
  /** Names the on-chain note (txid, pool, output), so a rescan can never pay twice. */
  readonly id: string;
  readonly user: UserId;
  readonly amount: bigint;
  /** Deep enough to withdraw. Before that it can be traded but not withdrawn. */
  readonly mature: boolean;
  readonly reversed: boolean;
}

/** One broadcast transaction paying one or more withdrawals. */
export interface BatchRecord {
  readonly txid: string;
  readonly withdrawalIds: readonly string[];
  /** Network fee the transaction pays, fixed when it was built. */
  readonly networkFee: bigint;
}

/**
 * Transactions the protocol makes for itself, moving nobody's balance:
 * `sweep` moves deposits from the treasury account into the reserve, and
 * `anchor` writes the log's hash-chain head into a reserve memo.
 */
export type TreasuryTxPurpose = "sweep" | "anchor";

export interface TreasuryTxRecord {
  readonly txid: string;
  readonly purpose: TreasuryTxPurpose;
  /** Network fee it pays, fixed when it was built. The protocol pays it from fees. */
  readonly networkFee: bigint;
  /** For an anchor, the memo it carries. */
  readonly memo: string | null;
  readonly state: "submitted" | "settled" | "failed";
  /** Engine time it was recorded. */
  readonly submittedAt: number;
}

export type WithdrawalState = "requested" | "submitted" | "settled" | "failed" | "cancelled";

export interface WithdrawalRecord {
  readonly id: string;
  readonly user: UserId;
  readonly address: string;
  readonly amount: bigint;
  /** Charged to the user; the network fee is paid out of protocol fees. */
  readonly fee: bigint;
  readonly state: WithdrawalState;
  readonly txid: string | null;
  /** Engine time the request was accepted: what daily limits count from. */
  readonly requestedAt: number;
}

export const userAccount = (user: UserId): AccountId => `user:${user}`;
/** A curve's own holdings: its real quote raised and its unsold tokens. */
export const curveAccount = (token: TokenId): AccountId => `curve:${token}`;
export const ammAccount = (token: TokenId): AccountId => `amm:${token}`;
export const mintAccount = (token: TokenId): AccountId => `mint:${token}`;

const USER_ID = /^[A-Za-z0-9_.-]{1,64}$/;

// ─── Engine ──────────────────────────────────────────────────────────────────

export class Engine {
  readonly params: CurveParams;
  readonly ledger = new Ledger();
  readonly chain = new HashChain();

  #fees: FeeParams;
  #clock: () => number;
  #onCommit: ((record: ChainRecord) => void) | undefined;
  #pools = new Map<TokenId, Pool>();
  #order: TokenId[] = [];
  #totalCurveQuote = 0n;

  // Per-command scratch, live only inside #command.
  #events: EngineEvent[] = [];
  #poolUndo: Map<TokenId, Pool | undefined> | null = null;

  // Custody bookkeeping. TxMaps, so a failed command rolls them back too.
  #addresses = new TxMap<UserId, AddressRecord>();
  #addressOwners = new TxMap<number, UserId>();
  #deposits = new TxMap<string, DepositRecord>();
  #withdrawals = new TxMap<string, WithdrawalRecord>();
  /** Withdrawal ids per broadcast transaction. */
  #batches = new TxMap<string, BatchRecord>();
  /** Sweeps and anchors, in the order they were recorded. */
  #treasuryTxs = new TxMap<string, TreasuryTxRecord>();
  /** Credited deposits not yet mature, per user: counted in the balance, excluded from withdrawals. */
  #immature = new TxMap<UserId, bigint>();
  #now = 0;

  constructor(options: EngineOptions) {
    validateCurve(options.params);
    validateFees(options.fees, options.params);
    this.params = options.params;
    this.#fees = { ...options.fees };
    this.#clock = options.clock ?? Date.now;
    this.#onCommit = options.onCommit;
  }

  // ─── Reads ───────────────────────────────────────────────────────────────

  get fees(): FeeParams {
    return { ...this.#fees };
  }

  /** Sum of `realQuoteRaised` across live curves (the contract's `totalCurveEth`). */
  get totalCurveQuote(): bigint {
    return this.#totalCurveQuote;
  }

  /** Every token, in creation order. */
  get tokens(): readonly TokenId[] {
    return [...this.#order];
  }

  pool(token: TokenId): Pool | undefined {
    const p = this.#pools.get(token);
    return p ? structuredClone(p) : undefined;
  }

  balance(user: UserId, asset: AssetId = QUOTE): bigint {
    return this.ledger.balance(userAccount(user), asset);
  }

  /** Supply net of burns, as `MemeToken.totalSupply()` reports it. */
  totalSupply(token: TokenId): bigint {
    this.#readPool(token);
    return this.params.totalSupply - this.ledger.balance(BURN, token);
  }

  /** Mirrors `quoteBuy`: the true fill, fee and refund, before committing. */
  quoteBuy(token: TokenId, grossIn: bigint): { tokensOut: bigint; fee: bigint; refund: bigint } {
    const p = this.#readPool(token);
    if (p.graduated) fail("AlreadyGraduated");
    const { tokensOut, fee, refund } = this.#sizeBuy(p, grossIn);
    return { tokensOut, fee, refund };
  }

  /** Mirrors `quoteSell`. */
  quoteSell(token: TokenId, tokenAmount: bigint): { quoteOut: bigint; fee: bigint } {
    const p = this.#readPool(token);
    if (p.graduated) fail("AlreadyGraduated");
    const gross = quoteOut(p.quoteReserve, p.tokenReserve, tokenAmount);
    const fee = (gross * this.#fees.tradeFeeBps) / BPS;
    return { quoteOut: gross - fee, fee };
  }

  /**
   * Curve marginal price exactly as the contract's `spotPriceE18` reports it:
   * quote base units per whole token, floored, and stale after graduation.
   * Kept for parity. Use `priceX18` for anything shown to a user, because in
   * zatoshi this floors to 0 for most of a launch. ZEC has 8 decimals, and an
   * early meme token is worth a fraction of one zatoshi (0.15 zats at launch).
   */
  spotPriceE18(token: TokenId): bigint {
    const p = this.#readPool(token);
    return spotPriceE18(p.quoteReserve, p.tokenReserve);
  }

  /** Live [quote, token] reserves: the AMM's once graduated, the curve's before. */
  liveReserves(token: TokenId): [quote: bigint, token: bigint] {
    const p = this.#readPool(token);
    return p.amm ? [p.amm.quote, p.amm.token] : [p.quoteReserve, p.tokenReserve];
  }

  /** Live price: quote base units per whole token, times 1e18, so sub-zatoshi prices keep 18 digits. */
  priceX18(token: TokenId): bigint {
    const [quote, tokens] = this.liveReserves(token);
    return (quote * E18 * E18) / tokens;
  }

  /** Fully diluted value in quote base units, at the live price, computed from reserves so nothing floors early. */
  marketCap(token: TokenId): bigint {
    const [quote, tokens] = this.liveReserves(token);
    return (quote * this.params.totalSupply) / tokens;
  }

  progressBps(token: TokenId): bigint {
    const p = this.#readPool(token);
    if (p.graduated) return BPS;
    return (p.realQuoteRaised * BPS) / this.params.graduationQuote;
  }

  /** Output of an exact-input AMM trade, as `getAmountsOut` prices it. */
  quoteAmm(token: TokenId, side: "buy" | "sell", amountIn: bigint): bigint {
    const amm = this.#pools.get(token)?.amm;
    if (!amm) fail("PairNotFound");
    return side === "buy" ? getAmountOut(amountIn, amm.quote, amm.token) : getAmountOut(amountIn, amm.token, amm.quote);
  }

  // ─── Custody reads ───────────────────────────────────────────────────────

  addressOf(user: UserId): AddressRecord | undefined {
    return this.#addresses.get(user);
  }

  /** Who owns the deposit address at diversifier `index`. */
  ownerOfIndex(index: number): UserId | undefined {
    return this.#addressOwners.get(index);
  }

  /** The next unused diversifier index. Indices are handed out densely from 0. */
  get nextAddressIndex(): number {
    return this.#addressOwners.size;
  }

  depositRecord(depositId: string): DepositRecord | undefined {
    return this.#deposits.get(depositId);
  }

  depositRecords(): DepositRecord[] {
    return [...this.#deposits.values()];
  }

  withdrawalRecord(withdrawalId: string): WithdrawalRecord | undefined {
    return this.#withdrawals.get(withdrawalId);
  }

  withdrawalRecords(state?: WithdrawalState): WithdrawalRecord[] {
    const all = [...this.#withdrawals.values()];
    return state ? all.filter((w) => w.state === state) : all;
  }

  batch(txid: string): BatchRecord | undefined {
    return this.#batches.get(txid);
  }

  treasuryTx(txid: string): TreasuryTxRecord | undefined {
    return this.#treasuryTxs.get(txid);
  }

  /** Oldest first. */
  treasuryTxs(state?: TreasuryTxRecord["state"]): TreasuryTxRecord[] {
    const all = [...this.#treasuryTxs.values()];
    return state ? all.filter((t) => t.state === state) : all;
  }

  /** Credited but not yet final: part of the balance, not withdrawable. */
  immatureBalance(user: UserId): bigint {
    return this.#immature.get(user) ?? 0n;
  }

  /** What the user can withdraw now: balance less immature deposits, never below zero. */
  withdrawable(user: UserId): bigint {
    const free = this.balance(user) - this.immatureBalance(user);
    return free > 0n ? free : 0n;
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  /** Apply any command. What the sequencer and a replay call. */
  execute(cmd: Command): Receipt<unknown> {
    switch (cmd.kind) {
      case "assignAddress":
        return this.assignAddress(cmd.user, cmd.index, cmd.address);
      case "creditDeposit":
        return this.creditDeposit(cmd);
      case "matureDeposit":
        return this.matureDeposit(cmd.depositId);
      case "reverseDeposit":
        return this.reverseDeposit(cmd.depositId);
      case "requestWithdrawal":
        return this.requestWithdrawal(cmd);
      case "cancelWithdrawal":
        return this.cancelWithdrawal(cmd.withdrawalId);
      case "submitWithdrawals":
        return this.submitWithdrawals(cmd.txid, cmd.withdrawalIds, cmd.networkFee);
      case "settleWithdrawals":
        return this.settleWithdrawals(cmd.txid);
      case "failWithdrawals":
        return this.failWithdrawals(cmd.txid);
      case "submitTreasuryTx":
        return this.submitTreasuryTx(cmd);
      case "settleTreasuryTx":
        return this.settleTreasuryTx(cmd.txid);
      case "failTreasuryTx":
        return this.failTreasuryTx(cmd.txid);
      case "create":
        return this.create(cmd.user, cmd);
      case "buy":
        return this.buy(cmd.user, cmd.token, cmd.value, cmd.minTokensOut);
      case "sell":
        return this.sell(cmd.user, cmd.token, cmd.tokenAmount, cmd.minQuoteOut);
      case "graduate":
        return this.graduate(cmd.token);
      case "swapQuoteForTokens":
        return this.swapQuoteForTokens(cmd.user, cmd.token, cmd.amountIn, cmd.minOut);
      case "swapTokensForQuote":
        return this.swapTokensForQuote(cmd.user, cmd.token, cmd.amountIn, cmd.minOut);
      case "setTradeFeeBps":
        return this.setTradeFeeBps(cmd.bps);
      case "setGraduationFeeBps":
        return this.setGraduationFeeBps(cmd.bps);
      case "setCreationFee":
        return this.setCreationFee(cmd.fee);
      case "setCreatorShareBps":
        return this.setCreatorShareBps(cmd.bps);
    }
  }

  // ─── Custody: addresses, deposits, withdrawals ────────────────────────────

  /** Give a user their deposit address: diversifier `index` of the treasury key. One per user, never reused. */
  assignAddress(user: UserId, index: number, address: string): Receipt<void> {
    return this.#command({ kind: "assignAddress", user, index, address }, () => {
      this.#user(user);
      if (!Number.isSafeInteger(index) || index < 0) fail("InvalidArgument", "bad address index");
      if (address.length === 0) fail("InvalidArgument", "empty address");
      if (this.#addresses.has(user)) fail("DuplicateId", `${user} already has a deposit address`);
      if (this.#addressOwners.has(index)) fail("DuplicateId", `address index ${index} is taken`);
      this.#addresses.set(user, { user, index, address });
      this.#addressOwners.set(index, user);
      this.#emit({ type: "AddressAssigned", user, index, address });
    });
  }

  /**
   * Credit an on-chain deposit, exactly once per note. An immature credit
   * can be traded immediately but not withdrawn until `matureDeposit`, and
   * `reverseDeposit` undoes it if a reorg drops the note.
   */
  creditDeposit(args: { depositId: string; user: UserId; amount: bigint; mature: boolean }): Receipt<void> {
    const { depositId, user, amount, mature } = args;
    return this.#command({ kind: "creditDeposit", depositId, user, amount, mature }, () => {
      this.#user(user);
      this.#id(depositId);
      if (this.#amount(amount) === 0n) fail("ZeroAmount");
      if (this.#deposits.has(depositId)) fail("DuplicateId", `deposit ${depositId} already credited`);
      this.#deposits.set(depositId, { id: depositId, user, amount, mature, reversed: false });
      if (!mature) this.#immature.set(user, this.immatureBalance(user) + amount);
      this.ledger.transfer(`deposit ${depositId}`, CHAIN, userAccount(user), QUOTE, amount);
      this.#emit({ type: "DepositCredited", depositId, user, amount, mature });
    });
  }

  /** The note is deep enough to be final: its value becomes withdrawable. */
  matureDeposit(depositId: string): Receipt<void> {
    return this.#command({ kind: "matureDeposit", depositId }, () => {
      const d = this.#deposit(depositId);
      if (d.mature || d.reversed) fail("InvalidState", `deposit ${depositId} is not pending`);
      this.#deposits.set(depositId, { ...d, mature: true });
      this.#unlock(d.user, d.amount);
      this.#emit({ type: "DepositMatured", depositId, user: d.user, amount: d.amount });
    });
  }

  /**
   * A reorg dropped an immature deposit, so take it back. Whatever the user
   * already spent can't be clawed from them, because it now sits with
   * whoever they traded with, and the protocol covers it: from fees first,
   * then as recorded loss. Immature funds can't be withdrawn, so a
   * double-spender can only move phantom value to other users. That exposure
   * is what the rails' fast-credit cap bounds.
   */
  reverseDeposit(depositId: string): Receipt<void> {
    return this.#command({ kind: "reverseDeposit", depositId }, () => {
      const d = this.#deposit(depositId);
      if (d.mature || d.reversed) fail("InvalidState", `deposit ${depositId} is final or already reversed`);
      this.#deposits.set(depositId, { ...d, reversed: true });
      this.#unlock(d.user, d.amount);

      const held = this.balance(d.user);
      const clawedBack = held < d.amount ? held : d.amount;
      this.ledger.transfer(`reverse ${depositId}`, userAccount(d.user), CHAIN, QUOTE, clawedBack);
      const covered = this.#protocolPay(`reverse ${depositId}`, CHAIN, d.amount - clawedBack);
      this.#emit({
        type: "DepositReversed",
        depositId,
        user: d.user,
        amount: d.amount,
        clawedBack,
        coveredByFees: covered.fromFees,
        coveredAsLoss: covered.asLoss,
      });
    });
  }

  /**
   * Move `amount + fee` out of the user's balance: the amount into pending
   * withdrawals, the fee to the protocol, which pays the network fee on
   * settlement. Only mature funds can leave.
   */
  requestWithdrawal(args: {
    withdrawalId: string;
    user: UserId;
    address: string;
    amount: bigint;
    fee: bigint;
  }): Receipt<void> {
    const { withdrawalId, user, address, amount, fee } = args;
    return this.#command({ kind: "requestWithdrawal", withdrawalId, user, address, amount, fee }, () => {
      this.#user(user);
      this.#id(withdrawalId);
      this.#amount(fee);
      if (address.length === 0) fail("InvalidArgument", "empty address");
      if (this.#amount(amount) === 0n) fail("ZeroAmount");
      if (this.#withdrawals.has(withdrawalId)) fail("DuplicateId", `withdrawal ${withdrawalId} exists`);
      const total = amount + fee;
      if (this.balance(user) < total) fail("InsufficientFunds");
      if (this.withdrawable(user) < total) fail("ImmatureFunds");

      this.#withdrawals.set(withdrawalId, {
        id: withdrawalId,
        user,
        address,
        amount,
        fee,
        state: "requested",
        txid: null,
        requestedAt: this.#now,
      });
      this.ledger.transfer(`withdraw ${withdrawalId}`, userAccount(user), PENDING_WITHDRAWALS, QUOTE, amount);
      this.ledger.transfer(`withdraw fee ${withdrawalId}`, userAccount(user), FEES, QUOTE, fee);
      this.#emit({ type: "WithdrawalRequested", withdrawalId, user, address, amount, fee });
    });
  }

  /** Undo a withdrawal that hasn't been put in a transaction yet, refunding amount and fee. */
  cancelWithdrawal(withdrawalId: string): Receipt<void> {
    return this.#command({ kind: "cancelWithdrawal", withdrawalId }, () => {
      const w = this.#withdrawal(withdrawalId);
      if (w.state !== "requested") fail("InvalidState", `withdrawal ${withdrawalId} is ${w.state}`);
      this.#refund(w, "cancelled");
      this.#emit({ type: "WithdrawalCancelled", withdrawalId, user: w.user });
    });
  }

  /**
   * Record that these withdrawals are paid by transaction `txid`. This must
   * be committed *before* the transaction is broadcast, so a crash between
   * the two leaves a record that the rails can rebroadcast, rather than a
   * sent payment the ledger doesn't know about.
   */
  submitWithdrawals(txid: string, withdrawalIds: readonly string[], networkFee: bigint): Receipt<void> {
    return this.#command({ kind: "submitWithdrawals", txid, withdrawalIds: [...withdrawalIds], networkFee }, () => {
      this.#id(txid);
      this.#amount(networkFee);
      if (withdrawalIds.length === 0) fail("InvalidArgument", "empty batch");
      if (this.#batches.has(txid)) fail("DuplicateId", `transaction ${txid} already recorded`);
      if (new Set(withdrawalIds).size !== withdrawalIds.length) fail("InvalidArgument", "duplicate id in batch");
      for (const id of withdrawalIds) {
        const w = this.#withdrawal(id);
        if (w.state !== "requested") fail("InvalidState", `withdrawal ${id} is ${w.state}`);
        this.#withdrawals.set(id, { ...w, state: "submitted", txid });
      }
      this.#batches.set(txid, { txid, withdrawalIds: [...withdrawalIds], networkFee });
      this.#emit({ type: "WithdrawalsSubmitted", txid, withdrawalIds: [...withdrawalIds] });
    });
  }

  /** The transaction is final: the value has left reserves, and so has the network fee recorded with it. */
  settleWithdrawals(txid: string): Receipt<void> {
    return this.#command({ kind: "settleWithdrawals", txid }, () => {
      const ids = this.#submittedBatch(txid);
      const networkFee = this.#batches.get(txid)?.networkFee ?? 0n;
      let total = 0n;
      for (const id of ids) {
        const w = this.#withdrawal(id);
        total += w.amount;
        this.#withdrawals.set(id, { ...w, state: "settled" });
      }
      this.ledger.transfer(`settle ${txid}`, PENDING_WITHDRAWALS, CHAIN, QUOTE, total);
      this.#protocolPay(`network fee ${txid}`, CHAIN, networkFee);
      this.#emit({ type: "WithdrawalsSettled", txid, withdrawalIds: ids, networkFee });
    });
  }

  /** The transaction will never confirm (expired or rejected): refund everyone in it. */
  failWithdrawals(txid: string): Receipt<void> {
    return this.#command({ kind: "failWithdrawals", txid }, () => {
      const ids = this.#submittedBatch(txid);
      for (const id of ids) this.#refund(this.#withdrawal(id), "failed");
      this.#emit({ type: "WithdrawalsFailed", txid, withdrawalIds: ids });
    });
  }

  /**
   * Record a sweep or anchor. Like `submitWithdrawals`, this is committed
   * before the transaction is broadcast. Nobody's balance moves: the value
   * stays in the protocol's own wallet, and only the network fee leaves,
   * paid from protocol fees on settlement.
   */
  submitTreasuryTx(args: { txid: string; purpose: TreasuryTxPurpose; networkFee: bigint; memo?: string | null }): Receipt<void> {
    const { txid, purpose, networkFee } = args;
    const memo = args.memo ?? null;
    return this.#command({ kind: "submitTreasuryTx", txid, purpose, networkFee, memo }, () => {
      this.#id(txid);
      this.#amount(networkFee);
      if (purpose !== "sweep" && purpose !== "anchor") fail("InvalidArgument", `bad treasury purpose "${String(purpose)}"`);
      if (memo !== null && (typeof memo !== "string" || new TextEncoder().encode(memo).length > 512)) {
        fail("InvalidArgument", "a memo is at most 512 bytes");
      }
      if (this.#treasuryTxs.has(txid) || this.#batches.has(txid)) fail("DuplicateId", `transaction ${txid} already recorded`);
      this.#treasuryTxs.set(txid, { txid, purpose, networkFee, memo, state: "submitted", submittedAt: this.#now });
      this.#emit({ type: "TreasuryTxSubmitted", txid, purpose, networkFee, memo });
    });
  }

  /** The transaction is final, and its network fee has left reserves. */
  settleTreasuryTx(txid: string): Receipt<void> {
    return this.#command({ kind: "settleTreasuryTx", txid }, () => {
      const t = this.#submittedTreasuryTx(txid);
      this.#treasuryTxs.set(txid, { ...t, state: "settled" });
      this.#protocolPay(`network fee ${txid}`, CHAIN, t.networkFee);
      this.#emit({ type: "TreasuryTxSettled", txid, purpose: t.purpose, networkFee: t.networkFee });
    });
  }

  /** The transaction will never confirm. Nothing was charged, so nothing is refunded. */
  failTreasuryTx(txid: string): Receipt<void> {
    return this.#command({ kind: "failTreasuryTx", txid }, () => {
      const t = this.#submittedTreasuryTx(txid);
      this.#treasuryTxs.set(txid, { ...t, state: "failed" });
      this.#emit({ type: "TreasuryTxFailed", txid, purpose: t.purpose });
    });
  }

  /**
   * Launch a token. `value` is what the creator spends in total, like the
   * contract's `msg.value`: the creation fee comes off first, and anything
   * left is the creator's own first buy, executed in the same step.
   */
  create(
    user: UserId,
    args: { name: string; symbol: string; metadataURI: string; value: bigint; minTokensOut?: bigint },
  ): Receipt<{ token: TokenId; tokensBought: bigint }> {
    const minTokensOut = args.minTokensOut ?? 0n;
    const cmd: Command = { kind: "create", user, ...args, minTokensOut };
    return this.#command(cmd, () => {
      this.#requireFunds(user, QUOTE, args.value);
      this.#amount(minTokensOut);
      if (args.name.length === 0 || args.symbol.length === 0) fail("EmptyMetadata");
      if (args.value < this.#fees.creationFee) fail("InsufficientCreationFee");

      const token = `tok_${this.#order.length}`;
      const P = this.params;
      const pool: Pool = {
        id: token,
        name: args.name,
        symbol: args.symbol,
        metadataURI: args.metadataURI,
        creator: user,
        createdAt: this.#now,
        quoteReserve: toU128(P.virtualQuoteReserve),
        tokenReserve: toU128(P.initialTokenReserve),
        realQuoteRaised: 0n,
        tokensSold: 0n,
        graduated: false,
        amm: null,
      };
      this.#poolUndo?.set(token, undefined);
      this.#pools.set(token, pool);
      this.#order.push(token);
      this.ledger.transfer(`mint ${token}`, mintAccount(token), curveAccount(token), token, P.totalSupply);
      this.#emit({
        type: "TokenCreated",
        token,
        creator: user,
        name: args.name,
        symbol: args.symbol,
        metadataURI: args.metadataURI,
      });

      const fee = this.#fees.creationFee;
      this.ledger.transfer(`creation fee ${token}`, userAccount(user), FEES, QUOTE, fee);

      const initialBuy = args.value - fee;
      let tokensBought = 0n;
      if (initialBuy > 0n) {
        tokensBought = this.#buy(user, token, initialBuy, minTokensOut);
      } else if (minTokensOut > 0n) {
        // Asked for tokens but sent nothing to buy them with.
        fail("SlippageExceeded", `0 < ${minTokensOut}`);
      }
      return { token, tokensBought };
    });
  }

  buy(user: UserId, token: TokenId, value: bigint, minTokensOut = 0n): Receipt<bigint> {
    return this.#command({ kind: "buy", user, token, value, minTokensOut }, () => {
      this.#requireFunds(user, QUOTE, value);
      this.#amount(minTokensOut);
      if (value === 0n) fail("ZeroAmount");
      return this.#buy(user, token, value, minTokensOut);
    });
  }

  sell(user: UserId, token: TokenId, tokenAmount: bigint, minQuoteOut = 0n): Receipt<bigint> {
    return this.#command({ kind: "sell", user, token, tokenAmount, minQuoteOut }, () => {
      this.#user(user);
      this.#amount(minQuoteOut);
      if (this.#amount(tokenAmount) === 0n) fail("ZeroAmount");

      const p0 = this.#readPool(token);
      if (p0.graduated) fail("AlreadyGraduated");
      if (tokenAmount > p0.tokensSold) fail("InsufficientBalance");

      const gross = quoteOut(p0.quoteReserve, p0.tokenReserve, tokenAmount);
      // The curve is symmetric and rounds in the pool's favour, so a sale can
      // never exceed the real quote that funded it.
      if (gross > p0.realQuoteRaised) fail("InsufficientBalance");

      const fee = (gross * this.#fees.tradeFeeBps) / BPS;
      const received = gross - fee;
      if (received < minQuoteOut) fail("SlippageExceeded", `${received} < ${minQuoteOut}`);

      const p = this.#mutPool(token);
      p.quoteReserve -= gross;
      p.tokenReserve = toU128(p.tokenReserve + tokenAmount);
      p.realQuoteRaised -= gross;
      p.tokensSold -= tokenAmount;
      this.#totalCurveQuote -= gross;
      this.#emit({
        type: "Trade",
        venue: "curve",
        token,
        trader: user,
        isBuy: false,
        quoteAmount: gross,
        tokenAmount,
        fee,
        quoteReserve: p.quoteReserve,
        tokenReserve: p.tokenReserve,
      });

      // The contract pulls the tokens last (`transferFrom`), so a seller short
      // of tokens fails here, after every check above has passed.
      this.ledger.transfer(`sell ${token}`, userAccount(user), curveAccount(token), token, tokenAmount);
      this.#payFee(`sell fee ${token}`, curveAccount(token), p0, fee);
      this.ledger.transfer(`sell ${token}`, curveAccount(token), userAccount(user), QUOTE, received);
      return received;
    });
  }

  /**
   * Recovery hatch, as in the contract. Graduation normally runs inside the
   * buy that crosses the threshold, and in the engine it cannot fail there,
   * so this only ever reports why it has nothing to do.
   */
  graduate(token: TokenId): Receipt<void> {
    return this.#command({ kind: "graduate", token }, () => {
      const p = this.#readPool(token);
      if (p.graduated) fail("AlreadyGraduated");
      if (p.realQuoteRaised < this.params.graduationQuote) fail("NotGraduated");
      this.#graduate(token);
    });
  }

  /** `swapExactETHForTokens` on the graduated pool. */
  swapQuoteForTokens(user: UserId, token: TokenId, amountIn: bigint, minOut = 0n): Receipt<bigint> {
    return this.#command({ kind: "swapQuoteForTokens", user, token, amountIn, minOut }, () => {
      this.#requireFunds(user, QUOTE, amountIn);
      this.#amount(minOut);
      const amm = this.#pools.get(token)?.amm;
      if (!amm) fail("PairNotFound");

      const out = getAmountOut(amountIn, amm.quote, amm.token);
      if (out < minOut) fail("InsufficientOutputAmount");

      this.ledger.transfer(`amm buy ${token}`, userAccount(user), ammAccount(token), QUOTE, amountIn);
      this.#pairSwap(token, amountIn, 0n, 0n, out);
      this.ledger.transfer(`amm buy ${token}`, ammAccount(token), userAccount(user), token, out);
      this.#emitAmmTrade(token, user, true, amountIn, out);
      return out;
    });
  }

  /** `swapExactTokensForETH` on the graduated pool. */
  swapTokensForQuote(user: UserId, token: TokenId, amountIn: bigint, minOut = 0n): Receipt<bigint> {
    return this.#command({ kind: "swapTokensForQuote", user, token, amountIn, minOut }, () => {
      this.#user(user);
      this.#amount(amountIn);
      this.#amount(minOut);
      const amm = this.#pools.get(token)?.amm;
      if (!amm) fail("PairNotFound");

      const out = getAmountOut(amountIn, amm.token, amm.quote);
      if (out < minOut) fail("InsufficientOutputAmount");

      // The router pulls the seller's tokens before the pair runs its checks.
      this.ledger.transfer(`amm sell ${token}`, userAccount(user), ammAccount(token), token, amountIn);
      this.#pairSwap(token, 0n, amountIn, out, 0n);
      this.ledger.transfer(`amm sell ${token}`, ammAccount(token), userAccount(user), QUOTE, out);
      this.#emitAmmTrade(token, user, false, out, amountIn);
      return out;
    });
  }

  setTradeFeeBps(bps: bigint): Receipt<void> {
    return this.#command({ kind: "setTradeFeeBps", bps }, () => this.#setFees({ ...this.#fees, tradeFeeBps: bps }));
  }

  setGraduationFeeBps(bps: bigint): Receipt<void> {
    return this.#command({ kind: "setGraduationFeeBps", bps }, () =>
      this.#setFees({ ...this.#fees, graduationFeeBps: bps }),
    );
  }

  setCreationFee(fee: bigint): Receipt<void> {
    return this.#command({ kind: "setCreationFee", fee }, () => this.#setFees({ ...this.#fees, creationFee: fee }));
  }

  /** The creator's share of each curve trade fee, in bps of the fee. */
  setCreatorShareBps(bps: bigint): Receipt<void> {
    return this.#command({ kind: "setCreatorShareBps", bps }, () => this.#setFees({ ...this.#fees, creatorShareBps: bps }));
  }

  // ─── Internals: the contract ports ───────────────────────────────────────

  /** Fee, net input and refund for a gross buy, including the final-buy size-down. */
  #sizeBuy(p: Pool, grossIn: bigint): { quoteIn: bigint; fee: bigint; refund: bigint; tokensOut: bigint } {
    const P = this.params;
    const bps = this.#fees.tradeFeeBps;
    let fee = (grossIn * bps) / BPS;
    let quoteIn = grossIn - fee;
    let refund = 0n;

    // Never let a buy overshoot the graduation threshold: size it down to land
    // exactly on it, and leave the rest with the buyer.
    const remaining = P.graduationQuote - p.realQuoteRaised;
    if (quoteIn > remaining) {
      quoteIn = remaining;
      let grossNeeded = mulDivUp(remaining, BPS, BPS - bps);
      if (grossNeeded > grossIn) grossNeeded = grossIn;
      fee = grossNeeded - quoteIn;
      refund = grossIn - grossNeeded;
    }

    let out = tokensOut(p.quoteReserve, p.tokenReserve, quoteIn);
    const left = P.curveSupply - p.tokensSold;
    if (out > left) out = left;
    return { quoteIn, fee, refund, tokensOut: out };
  }

  /** `_buy`: the shared buy path for `buy` and the creator's first buy. */
  #buy(user: UserId, token: TokenId, grossIn: bigint, minTokensOut: bigint): bigint {
    const p0 = this.#readPool(token);
    if (p0.graduated) fail("AlreadyGraduated");

    const { quoteIn, fee, tokensOut: bought } = this.#sizeBuy(p0, grossIn);
    if (bought < minTokensOut) fail("SlippageExceeded", `${bought} < ${minTokensOut}`);
    if (bought === 0n) fail("ZeroAmount");

    const p = this.#mutPool(token);
    p.quoteReserve = toU128(p.quoteReserve + quoteIn);
    p.tokenReserve -= bought;
    p.realQuoteRaised = toU128(p.realQuoteRaised + quoteIn);
    p.tokensSold = toU128(p.tokensSold + bought);
    this.#totalCurveQuote += quoteIn;
    this.#emit({
      type: "Trade",
      venue: "curve",
      token,
      trader: user,
      isBuy: true,
      quoteAmount: quoteIn,
      tokenAmount: bought,
      fee,
      quoteReserve: p.quoteReserve,
      tokenReserve: p.tokenReserve,
    });

    // Any refund simply never leaves the buyer's balance.
    this.ledger.transfer(`buy ${token}`, userAccount(user), curveAccount(token), QUOTE, quoteIn);
    this.#payFee(`buy fee ${token}`, userAccount(user), p0, fee);
    this.ledger.transfer(`buy ${token}`, curveAccount(token), userAccount(user), token, bought);

    if (p.realQuoteRaised >= this.params.graduationQuote) this.#graduate(token);
    return bought;
  }

  /**
   * `_graduate`: close the curve and seed the built-in DEX. The contract does
   * this through `addLiquidityETH` into a fresh pair, which takes both sides
   * exactly as given, and burns the LP. Here the pool is simply protocol-owned
   * and has no LP token to burn, which is the same outcome: nobody can ever
   * withdraw that liquidity.
   */
  #graduate(token: TokenId): void {
    const P = this.params;
    const p = this.#mutPool(token);
    const raised = p.realQuoteRaised;
    const protocolFee = (raised * this.#fees.graduationFeeBps) / BPS;
    const liquidity = raised - protocolFee;
    const unsold = P.curveSupply - p.tokensSold;

    // validateCurve guarantees both; asserted so a bad config can't slip past.
    if (sqrt(liquidity * P.lpSupply) <= MINIMUM_LIQUIDITY) fail("InvariantViolation", "graduation cannot seed a pool");
    if (liquidity > U112_MAX || P.lpSupply > U112_MAX) fail("InvariantViolation", "pool reserves exceed uint112");

    p.graduated = true;
    p.realQuoteRaised = 0n;
    this.#totalCurveQuote -= raised;
    p.amm = { quote: liquidity, token: P.lpSupply };

    this.ledger.transfer(`graduate ${token}`, curveAccount(token), ammAccount(token), QUOTE, liquidity);
    this.ledger.transfer(`graduation fee ${token}`, curveAccount(token), FEES, QUOTE, protocolFee);
    this.ledger.transfer(`graduate ${token}`, curveAccount(token), ammAccount(token), token, P.lpSupply);
    this.ledger.transfer(`burn unsold ${token}`, curveAccount(token), BURN, token, unsold);
    this.#emit({
      type: "Graduated",
      token,
      quoteLiquidity: liquidity,
      tokenLiquidity: P.lpSupply,
      protocolFee,
      unsoldBurned: unsold,
    });
  }

  /**
   * `UnderwaterPair.swap`, with the inputs already paid in. Same checks in the
   * same order: some output, output below reserves, then the fee-adjusted k.
   */
  #pairSwap(token: TokenId, quoteIn: bigint, tokenIn: bigint, quoteOutAmt: bigint, tokenOutAmt: bigint): void {
    const p = this.#mutPool(token);
    const amm = p.amm;
    if (!amm) fail("PairNotFound");
    if (quoteOutAmt === 0n && tokenOutAmt === 0n) fail("InsufficientOutputAmount");
    if (quoteOutAmt >= amm.quote || tokenOutAmt >= amm.token) fail("InsufficientLiquidity");
    if (quoteIn === 0n && tokenIn === 0n) fail("InsufficientInputAmount");

    const balanceQuote = amm.quote + quoteIn - quoteOutAmt;
    const balanceToken = amm.token + tokenIn - tokenOutAmt;
    const adjustedQuote = balanceQuote * 1000n - quoteIn * 3n;
    const adjustedToken = balanceToken * 1000n - tokenIn * 3n;
    if (adjustedQuote * adjustedToken < amm.quote * amm.token * 1_000_000n) fail("InvariantViolation", "K");
    if (balanceQuote > U112_MAX || balanceToken > U112_MAX) fail("ValueOverflow");

    amm.quote = balanceQuote;
    amm.token = balanceToken;
  }

  #emitAmmTrade(token: TokenId, user: UserId, isBuy: boolean, quoteAmount: bigint, tokenAmount: bigint): void {
    const amm = this.#pools.get(token)?.amm;
    if (!amm) fail("PairNotFound");
    this.#emit({
      type: "Trade",
      venue: "amm",
      token,
      trader: user,
      isBuy,
      quoteAmount,
      tokenAmount,
      // The 0.3% stays in the pool; it is not a transfer to anyone.
      fee: 0n,
      quoteReserve: amm.quote,
      tokenReserve: amm.token,
    });
  }

  #setFees(next: FeeParams): void {
    validateFees(next, this.params);
    this.#fees = next;
    this.#emit({ type: "FeesUpdated", ...next });
  }

  // ─── Internals: plumbing ─────────────────────────────────────────────────

  #command<T>(cmd: Command, fn: () => T): Receipt<T> {
    this.ledger.begin();
    for (const m of this.#maps()) m.begin();
    this.#poolUndo = new Map();
    this.#events = [];
    this.#now = this.#clock();
    const orderLength = this.#order.length;
    const totalCurveQuote = this.#totalCurveQuote;
    const fees = this.#fees;

    try {
      const result = fn();
      const events = this.#events;
      const ts = this.#now;
      const record = this.chain.append({ ts, command: cmd, result, events });
      // Durable before visible: persist first, and if that fails, the
      // command never happened.
      try {
        this.#onCommit?.(record);
      } catch (err) {
        this.chain.pop();
        throw err;
      }
      this.ledger.commit();
      for (const m of this.#maps()) m.commit();
      this.#poolUndo = null;
      this.#events = [];
      return { seq: record.seq, ts, result, events, hash: record.hash };
    } catch (err) {
      this.ledger.rollback();
      for (const m of this.#maps()) m.rollback();
      for (const [id, previous] of this.#poolUndo ?? []) {
        if (previous) this.#pools.set(id, previous);
        else this.#pools.delete(id);
      }
      this.#poolUndo = null;
      this.#order.length = orderLength;
      this.#totalCurveQuote = totalCurveQuote;
      this.#fees = fees;
      this.#events = [];
      throw err;
    }
  }

  #maps(): readonly TxMap<unknown, unknown>[] {
    return [
      this.#addresses,
      this.#addressOwners,
      this.#deposits,
      this.#withdrawals,
      this.#batches,
      this.#treasuryTxs,
      this.#immature,
    ] as readonly TxMap<unknown, unknown>[];
  }

  #id(id: string): void {
    if (typeof id !== "string" || id.length === 0 || id.length > 128 || id.includes("|")) {
      fail("InvalidArgument", `bad id "${id}"`);
    }
  }

  #deposit(depositId: string): DepositRecord {
    const d = this.#deposits.get(depositId);
    if (!d) fail("UnknownId", `deposit ${depositId}`);
    return d;
  }

  #withdrawal(withdrawalId: string): WithdrawalRecord {
    const w = this.#withdrawals.get(withdrawalId);
    if (!w) fail("UnknownId", `withdrawal ${withdrawalId}`);
    return w;
  }

  #submittedBatch(txid: string): readonly string[] {
    const ids = this.#batches.get(txid)?.withdrawalIds;
    if (!ids) fail("UnknownId", `transaction ${txid}`);
    for (const id of ids) {
      const state = this.#withdrawal(id).state;
      if (state !== "submitted") fail("InvalidState", `withdrawal ${id} is ${state}`);
    }
    return ids;
  }

  /**
   * A curve trade fee: the creator's share straight into their balance, the
   * rest to the protocol. The protocol's part rounds up, so a split never
   * mints a zatoshi.
   */
  #payFee(memo: string, from: AccountId, pool: Pool, fee: bigint): void {
    const toCreator = (fee * creatorShare(this.#fees)) / BPS;
    this.ledger.transfer(memo, from, FEES, QUOTE, fee - toCreator);
    if (toCreator > 0n) {
      this.ledger.transfer(`${memo} (creator)`, from, userAccount(pool.creator), QUOTE, toCreator);
      this.#emit({ type: "CreatorFee", token: pool.id, creator: pool.creator, amount: toCreator });
    }
  }

  #submittedTreasuryTx(txid: string): TreasuryTxRecord {
    const t = this.#treasuryTxs.get(txid);
    if (!t) fail("UnknownId", `transaction ${txid}`);
    if (t.state !== "submitted") fail("InvalidState", `transaction ${txid} is ${t.state}`);
    return t;
  }

  #unlock(user: UserId, amount: bigint): void {
    const left = this.immatureBalance(user) - amount;
    if (left < 0n) fail("InvariantViolation", `immature balance for ${user} went negative`);
    if (left === 0n) this.#immature.delete(user);
    else this.#immature.set(user, left);
  }

  /** Return a withdrawal's amount and fee to its user. */
  #refund(w: WithdrawalRecord, state: "failed" | "cancelled"): void {
    this.#withdrawals.set(w.id, { ...w, state });
    this.ledger.transfer(`refund ${w.id}`, PENDING_WITHDRAWALS, userAccount(w.user), QUOTE, w.amount);
    this.#protocolPay(`refund fee ${w.id}`, userAccount(w.user), w.fee);
  }

  /**
   * The protocol pays `amount` to `to`: from collected fees while they last,
   * and past that as recorded loss, so a shortfall is never silent.
   */
  #protocolPay(memo: string, to: AccountId, amount: bigint): { fromFees: bigint; asLoss: bigint } {
    const available = this.ledger.balance(FEES, QUOTE);
    const fromFees = available < amount ? available : amount;
    const asLoss = amount - fromFees;
    this.ledger.transfer(memo, FEES, to, QUOTE, fromFees);
    this.ledger.transfer(`${memo} (loss)`, LOSS, to, QUOTE, asLoss);
    return { fromFees, asLoss };
  }

  #readPool(token: TokenId): Pool {
    const p = this.#pools.get(token);
    if (!p) fail("UnknownToken");
    return p;
  }

  /** The live pool, after saving a copy for rollback the first time it's touched. */
  #mutPool(token: TokenId): Pool {
    const p = this.#readPool(token);
    if (this.#poolUndo && !this.#poolUndo.has(token)) this.#poolUndo.set(token, structuredClone(p));
    return p;
  }

  #emit(event: EngineEvent): void {
    this.#events.push(event);
  }

  #user(user: UserId): void {
    if (!USER_ID.test(user)) fail("InvalidArgument", `bad user id "${user}"`);
  }

  #amount(value: bigint): bigint {
    if (typeof value !== "bigint" || value < 0n) fail("InvalidArgument", "amounts are non-negative bigints");
    return value;
  }

  /** The EVM's own pre-check: a sender cannot attach more value than it holds. */
  #requireFunds(user: UserId, asset: AssetId, amount: bigint): void {
    this.#user(user);
    this.#amount(amount);
    if (this.ledger.balance(userAccount(user), asset) < amount) fail("InsufficientFunds");
  }
}
