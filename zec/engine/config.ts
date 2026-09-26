/**
 * Curve and fee parameters.
 *
 * The launchpad's geometry is fixed by its constructor constants: a virtual
 * quote reserve V, a virtual token reserve equal to the full supply, and a
 * graduation threshold of 4V. With those, selling exactly the 800M curve
 * tokens raises exactly 4V, so the token-side and quote-side exits bind at
 * the same instant (see the header of src/UnderwaterLaunchpad.sol).
 * `validateCurve` refuses any parameter set that breaks that property.
 */
import { fail } from "./errors.ts";
import { E18, MINIMUM_LIQUIDITY, U112_MAX, U128_MAX, sqrt } from "./math.ts";

export const BPS = 10_000n;

export interface CurveParams {
  /** Full supply minted per launch, in token base units. */
  readonly totalSupply: bigint;
  /** Portion sellable on the bonding curve. */
  readonly curveSupply: bigint;
  /** Portion held back to seed the AMM at graduation. */
  readonly lpSupply: bigint;
  /** Virtual quote seeding the curve. Never withdrawable (`VIRTUAL_ETH_RESERVE`). */
  readonly virtualQuoteReserve: bigint;
  /** Starting virtual token reserve (`INITIAL_TOKEN_RESERVE`). */
  readonly initialTokenReserve: bigint;
  /** Net quote that must accumulate before graduation (`GRADUATION_ETH`). */
  readonly graduationQuote: bigint;
  /** Hard ceilings the admin setters cannot exceed. */
  readonly maxTradeFeeBps: bigint;
  readonly maxGraduationFeeBps: bigint;
  readonly maxCreationFee: bigint;
}

export interface FeeParams {
  tradeFeeBps: bigint;
  graduationFeeBps: bigint;
  creationFee: bigint;
}

const TOTAL_SUPPLY = 1_000_000_000n * E18;
const CURVE_SUPPLY = 800_000_000n * E18;
const LP_SUPPLY = 200_000_000n * E18;

/** The constants compiled into UnderwaterLaunchpad.sol, in wei. Parity runs against these. */
export const EVM_PARAMS: CurveParams = Object.freeze({
  totalSupply: TOTAL_SUPPLY,
  curveSupply: CURVE_SUPPLY,
  lpSupply: LP_SUPPLY,
  virtualQuoteReserve: E18,
  initialTokenReserve: TOTAL_SUPPLY,
  graduationQuote: 4n * E18,
  maxTradeFeeBps: 200n,
  maxGraduationFeeBps: 1_000n,
  maxCreationFee: 10n ** 16n,
});

export const ZATS_PER_ZEC = 100_000_000n;

/**
 * Zcash mainnet, in zatoshi. Same geometry as the EVM launchpad, with
 * V = 1.5 ZEC: at $1,534/ZEC a launch starts near $2.3K FDV and graduates
 * after 6 ZEC raised, near $57.5K FDV (docs/underwater-zec-v2.md §3).
 */
export const ZEC_PARAMS: CurveParams = Object.freeze({
  totalSupply: TOTAL_SUPPLY,
  curveSupply: CURVE_SUPPLY,
  lpSupply: LP_SUPPLY,
  virtualQuoteReserve: 150_000_000n,
  initialTokenReserve: TOTAL_SUPPLY,
  graduationQuote: 600_000_000n,
  maxTradeFeeBps: 200n,
  maxGraduationFeeBps: 1_000n,
  maxCreationFee: 1_000_000n, // 0.01 ZEC
});

export function validateCurve(p: CurveParams): void {
  for (const [name, value] of Object.entries(p)) {
    if (typeof value !== "bigint" || value < 0n) fail("InvalidConfig", `${name} must be a non-negative bigint`);
  }
  if (p.totalSupply === 0n || p.curveSupply === 0n || p.lpSupply === 0n || p.virtualQuoteReserve === 0n) {
    fail("InvalidConfig", "supplies and the virtual reserve must be positive");
  }
  if (p.curveSupply + p.lpSupply !== p.totalSupply) {
    fail("InvalidConfig", "curve supply plus LP supply must equal total supply");
  }
  if (p.initialTokenReserve - p.curveSupply !== p.lpSupply) {
    fail("InvalidConfig", "the virtual token floor must equal the LP allocation");
  }

  // Selling the whole curve must raise exactly the graduation threshold.
  const numerator = p.virtualQuoteReserve * p.curveSupply;
  const denominator = p.initialTokenReserve - p.curveSupply;
  if (numerator % denominator !== 0n || numerator / denominator !== p.graduationQuote) {
    fail("InvalidConfig", "graduationQuote must equal the exact raise from selling curveSupply");
  }

  // The buy path divides by (BPS - tradeFeeBps) when sizing the final buy.
  if (p.maxTradeFeeBps >= BPS) fail("InvalidConfig", "maxTradeFeeBps must be below 100%");
  if (p.maxGraduationFeeBps > BPS) fail("InvalidConfig", "maxGraduationFeeBps cannot exceed 100%");

  // Storage widths: the launchpad keeps reserves in uint128, the pair in uint112.
  if (p.initialTokenReserve > U128_MAX || p.virtualQuoteReserve + p.graduationQuote > U128_MAX) {
    fail("InvalidConfig", "curve reserves must fit uint128");
  }
  if (p.lpSupply > U112_MAX || p.graduationQuote > U112_MAX) fail("InvalidConfig", "pool reserves must fit uint112");

  // Graduation must always be able to seed a pool, even at the maximum fee:
  // a V2 pair's first deposit reverts unless it can lock MINIMUM_LIQUIDITY.
  const leanest = p.graduationQuote - (p.graduationQuote * p.maxGraduationFeeBps) / BPS;
  if (sqrt(leanest * p.lpSupply) <= MINIMUM_LIQUIDITY) {
    fail("InvalidConfig", "graduation raise too small to seed a pool at the maximum fee");
  }
}

export function validateFees(f: FeeParams, p: CurveParams): void {
  if (f.tradeFeeBps < 0n || f.graduationFeeBps < 0n || f.creationFee < 0n) {
    fail("InvalidArgument", "fees cannot be negative");
  }
  if (f.tradeFeeBps > p.maxTradeFeeBps || f.graduationFeeBps > p.maxGraduationFeeBps || f.creationFee > p.maxCreationFee) {
    fail("FeeTooHigh");
  }
}
