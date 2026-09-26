/**
 * Integer math, ported line for line from the contracts.
 *
 * Every function here uses the same operations in the same order as its
 * Solidity source, so it floors wherever Solidity floors. bigint division
 * truncates toward zero exactly like the EVM's on non-negative operands, and
 * every operand here is non-negative.
 */
import { fail } from "./errors.ts";

export const E18 = 10n ** 18n;
export const U128_MAX = (1n << 128n) - 1n;
export const U112_MAX = (1n << 112n) - 1n;

/** Liquidity a V2 pair locks forever on its first deposit. */
export const MINIMUM_LIQUIDITY = 1_000n;

// ─── CurveMath (src/lib/CurveMath.sol) ──────────────────────────────────────

/** Tokens out for `quoteIn` on a virtual constant-product curve. */
export function tokensOut(quoteReserve: bigint, tokenReserve: bigint, quoteIn: bigint): bigint {
  if (quoteIn === 0n) return 0n;
  return (tokenReserve * quoteIn) / (quoteReserve + quoteIn);
}

/** Quote out for selling `tokensIn` back into the curve. */
export function quoteOut(quoteReserve: bigint, tokenReserve: bigint, tokensIn: bigint): bigint {
  if (tokensIn === 0n) return 0n;
  return (quoteReserve * tokensIn) / (tokenReserve + tokensIn);
}

/** Quote required to buy exactly `tokensDesired`. Rounds up: the buyer pays more. */
export function quoteInForTokens(quoteReserve: bigint, tokenReserve: bigint, tokensDesired: bigint): bigint {
  if (tokensDesired === 0n) return 0n;
  if (tokensDesired >= tokenReserve) fail("InsufficientReserve");
  const numerator = quoteReserve * tokensDesired;
  const denominator = tokenReserve - tokensDesired;
  const quotient = numerator / denominator;
  return quotient * denominator === numerator ? quotient : quotient + 1n;
}

/** Marginal price, quote per whole token, scaled by 1e18. */
export function spotPriceE18(quoteReserve: bigint, tokenReserve: bigint): bigint {
  if (tokenReserve === 0n) return 0n;
  return (quoteReserve * E18) / tokenReserve;
}

// ─── UnderwaterLaunchpad helpers ────────────────────────────────────────────

/** Ceiling of `a * b / d`: `_mulDivUp`, used so fees round up. */
export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  const product = a * b;
  const quotient = product / d;
  return quotient * d === product ? quotient : quotient + 1n;
}

/** `_toU128`: the launchpad stores reserves as uint128 and reverts past it. */
export function toU128(value: bigint): bigint {
  if (value > U128_MAX) fail("ValueOverflow");
  return value;
}

// ─── UnderwaterLibrary (src/dex/libraries/UnderwaterLibrary.sol) ───────────

/** Output for an exact input, after the 0.3% fee. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n) fail("InsufficientInputAmount");
  if (reserveIn === 0n || reserveOut === 0n) fail("InsufficientLiquidity");
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

/** Input required for an exact output, after the 0.3% fee. Rounds up. */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut === 0n) fail("InsufficientOutputAmount");
  if (reserveIn === 0n || reserveOut === 0n) fail("InsufficientLiquidity");
  if (amountOut >= reserveOut) fail("InsufficientLiquidity");
  const numerator = reserveIn * amountOut * 1000n;
  const denominator = (reserveOut - amountOut) * 997n;
  return numerator / denominator + 1n;
}

/** Integer square root, floored: the `Math.sqrt` a V2 pair mints LP with. */
export function sqrt(n: bigint): bigint {
  if (n < 0n) fail("InvalidArgument", "sqrt of a negative number");
  if (n < 2n) return n;
  // Newton's method from an upper bound; converges monotonically downward.
  let x = 1n << (BigInt(n.toString(2).length + 1) >> 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
