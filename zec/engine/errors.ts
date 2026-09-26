/**
 * Error codes, shared with the Solidity half of the parity harness
 * (`test/zec/ZecParity.t.sol`).
 *
 * Codes 1–14 each mirror a named revert in the launchpad or the DEX. The
 * harness maps every Solidity error selector to the same number, so a code
 * mismatch means the engine rejected, or accepted, something the contracts
 * would not have.
 *
 * Codes from 50 up exist only in the engine. They cover what the EVM enforces
 * before a contract runs (a sender cannot spend more than it holds) and inputs
 * that a Solidity `uint256` makes impossible, so they have no contract
 * counterpart and never appear in a parity trace.
 */
export const ErrorCode = {
  ZeroAmount: 1,
  UnknownToken: 2,
  AlreadyGraduated: 3,
  SlippageExceeded: 4,
  InsufficientBalance: 5,
  NotGraduated: 6,
  InsufficientCreationFee: 7,
  EmptyMetadata: 8,
  FeeTooHigh: 9,
  InsufficientOutputAmount: 10,
  InsufficientLiquidity: 11,
  InsufficientInputAmount: 12,
  PairNotFound: 13,
  InsufficientReserve: 14,

  InsufficientFunds: 50,
  ValueOverflow: 51,
  InvalidConfig: 52,
  InvariantViolation: 53,
  InvalidArgument: 54,
  /** Enough balance, but part of it is deposits not yet final enough to withdraw. */
  ImmatureFunds: 55,
  DuplicateId: 56,
  UnknownId: 57,
  InvalidState: 58,
} as const;

export type ErrorName = keyof typeof ErrorCode;

export class EngineError extends Error {
  override readonly name = "EngineError";
  readonly code: ErrorName;

  constructor(code: ErrorName, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }

  /** The numeric code, as recorded in a parity trace. */
  get numeric(): number {
    return ErrorCode[this.code];
  }
}

export function fail(code: ErrorName, detail?: string): never {
  throw new EngineError(code, detail);
}
