/**
 * The contract between the two halves of the parity harness: how an
 * operation is encoded, how the engine applies it, and the exact state vector
 * recorded after it. `test/zec/ZecParity.t.sol` implements the same three
 * things against the real contracts, and any change here must be mirrored
 * there.
 */
import {
  EVM_PARAMS,
  Engine,
  EngineError,
  FEES,
  QUOTE,
  type TokenId,
} from "../engine/index.ts";

/** Operation kinds. Must match the constants in ZecParity.t.sol. */
export const Op = {
  Create: 0,
  Buy: 1,
  Sell: 2,
  AmmBuy: 3,
  AmmSell: 4,
  Graduate: 5,
  SetTradeFee: 6,
  SetGradFee: 7,
  SetCreationFee: 8,
} as const;
export type OpKind = (typeof Op)[keyof typeof Op];

const OP_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Op).map(([k, v]) => [v, k]));

/** Five numbers per op: kind, user index, token index, and two amounts whose meaning depends on the kind. */
export interface ParityOp {
  readonly kind: OpKind;
  readonly user: number;
  readonly token: number;
  readonly a: bigint;
  readonly b: bigint;
}

export interface Scenario {
  readonly seed: number;
  readonly tradeFeeBps: bigint;
  readonly graduationFeeBps: bigint;
  readonly creationFee: bigint;
  readonly users: number;
  readonly ops: ParityOp[];
}

/** Each simulated user's starting balance, on both sides: 1M ETH. */
export const USER_FUNDS = 1_000_000n * 10n ** 18n;

export const userId = (i: number): string => `u${i}`;

export function newEngine(sc: Scenario): Engine {
  const engine = new Engine({
    params: EVM_PARAMS,
    fees: { tradeFeeBps: sc.tradeFeeBps, graduationFeeBps: sc.graduationFeeBps, creationFee: sc.creationFee },
    clock: () => 0,
  });
  for (let i = 0; i < sc.users; i++) {
    engine.creditDeposit({ depositId: `genesis-${userId(i)}`, user: userId(i), amount: USER_FUNDS, mature: true });
  }
  return engine;
}

/**
 * Apply one op and return its outcome code exactly as the Solidity side
 * records it: 0 for success, otherwise the shared error number.
 */
export function applyOp(engine: Engine, tokens: TokenId[], op: ParityOp): number {
  const user = userId(op.user);
  const token = tokens[op.token] ?? `missing_${op.token}`;
  try {
    switch (op.kind) {
      case Op.Create:
        tokens.push(
          engine.create(user, { name: "Parity", symbol: "PAR", metadataURI: "ipfs://parity", value: op.a, minTokensOut: op.b })
            .result.token,
        );
        break;
      case Op.Buy:
        engine.buy(user, token, op.a, op.b);
        break;
      case Op.Sell:
        engine.sell(user, token, op.a, op.b);
        break;
      case Op.AmmBuy:
        engine.swapQuoteForTokens(user, token, op.a, op.b);
        break;
      case Op.AmmSell:
        engine.swapTokensForQuote(user, token, op.a, op.b);
        break;
      case Op.Graduate:
        engine.graduate(token);
        break;
      case Op.SetTradeFee:
        engine.setTradeFeeBps(op.a);
        break;
      case Op.SetGradFee:
        engine.setGraduationFeeBps(op.a);
        break;
      case Op.SetCreationFee:
        engine.setCreationFee(op.a);
        break;
    }
    return 0;
  } catch (err) {
    if (err instanceof EngineError) return err.numeric;
    throw err;
  }
}

/**
 * The full observable state after an op, in the order ZecParity.t.sol writes
 * it: outcome, fee recipient, total curve quote, then each user's quote and
 * token balances, then each token's curve, pool and supply.
 */
export function stateVector(engine: Engine, tokens: readonly TokenId[], users: number, code: number): string[] {
  const v: bigint[] = [BigInt(code), engine.ledger.balance(FEES, QUOTE), engine.totalCurveQuote];
  for (let u = 0; u < users; u++) {
    v.push(engine.balance(userId(u)));
    for (const t of tokens) v.push(engine.balance(userId(u), t));
  }
  for (const t of tokens) {
    const p = engine.pool(t);
    if (!p) throw new Error(`pool ${t} missing`);
    v.push(
      p.quoteReserve,
      p.tokenReserve,
      p.realQuoteRaised,
      p.tokensSold,
      p.graduated ? 1n : 0n,
      p.amm?.quote ?? 0n,
      p.amm?.token ?? 0n,
      engine.totalSupply(t),
    );
  }
  return v.map(String);
}

/** Human names for each slot of `stateVector`, for mismatch reports. */
export function stateLabels(tokenCount: number, users: number): string[] {
  const labels = ["outcome", "feeRecipient.quote", "totalCurveQuote"];
  for (let u = 0; u < users; u++) {
    labels.push(`${userId(u)}.quote`);
    for (let t = 0; t < tokenCount; t++) labels.push(`${userId(u)}.tok_${t}`);
  }
  const fields = ["quoteReserve", "tokenReserve", "realQuoteRaised", "tokensSold", "graduated", "amm.quote", "amm.token", "totalSupply"];
  for (let t = 0; t < tokenCount; t++) for (const f of fields) labels.push(`tok_${t}.${f}`);
  return labels;
}

export function describeOp(op: ParityOp): string {
  return `${OP_NAMES[op.kind]}(user=${op.user}, token=${op.token}, a=${op.a}, b=${op.b})`;
}

// ─── Fixture encoding ───────────────────────────────────────────────────────
// Numbers are decimal strings: JSON numbers cannot carry uint256, and forge's
// typed parsers coerce numeric strings.

export function encodeScenario(sc: Scenario): string {
  const flat = sc.ops.flatMap((op) => [op.kind, op.user, op.token, op.a, op.b].map(String));
  return JSON.stringify({
    seed: sc.seed,
    tradeFeeBps: String(sc.tradeFeeBps),
    graduationFeeBps: String(sc.graduationFeeBps),
    creationFee: String(sc.creationFee),
    users: String(sc.users),
    flat,
  });
}

export function decodeScenario(json: string): Scenario {
  const raw = JSON.parse(json) as {
    seed: number;
    tradeFeeBps: string;
    graduationFeeBps: string;
    creationFee: string;
    users: string;
    flat: string[];
  };
  const ops: ParityOp[] = [];
  for (let i = 0; i + 4 < raw.flat.length; i += 5) {
    const [kind, user, token, a, b] = raw.flat.slice(i, i + 5) as [string, string, string, string, string];
    ops.push({ kind: Number(kind) as OpKind, user: Number(user), token: Number(token), a: BigInt(a), b: BigInt(b) });
  }
  return {
    seed: raw.seed,
    tradeFeeBps: BigInt(raw.tradeFeeBps),
    graduationFeeBps: BigInt(raw.graduationFeeBps),
    creationFee: BigInt(raw.creationFee),
    users: Number(raw.users),
    ops,
  };
}
