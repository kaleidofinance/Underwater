/**
 * Random scenario generator.
 *
 * It keeps its own engine in step with the ops it emits and uses it to aim:
 * slippage bounds set exactly at, and one unit past, the quoted fill; sells
 * sized from what a user actually holds; buys sized to land on, just under,
 * or through the graduation threshold. Aiming is safe because the engine
 * isn't the judge here. Every op is replayed against the real contracts, and
 * the contracts' result is the one that counts.
 *
 * The one thing it never emits is an op the EVM itself would reject before
 * the contract runs, i.e. spending more ETH or tokens than a user holds.
 * Those fail as raw EVM errors on the Solidity side with no counterpart
 * worth comparing, and the engine's own unit tests cover them instead.
 */
import { BPS, type Engine, type TokenId, mulDivUp } from "../engine/index.ts";
import { Op, applyOp, newEngine, userId, type ParityOp, type Scenario } from "./ops.ts";
import { Rng } from "./rng.ts";

const MAX_TOKENS = 6;

export function generateScenario(seed: number, opCount = 160, users = 4): Scenario {
  const r = new Rng(seed);
  const scenario: Scenario = {
    seed,
    tradeFeeBps: r.pick([0n, 50n, 100n, 200n]),
    graduationFeeBps: r.pick([0n, 500n, 1_000n]),
    creationFee: r.pick([0n, 10n ** 15n, 10n ** 16n]),
    users,
    ops: [],
  };

  const engine = newEngine(scenario);
  const tokens: TokenId[] = [];
  const g = new Aim(r, engine, tokens, users);

  const emit = (op: ParityOp | null): void => {
    if (!op) return;
    scenario.ops.push(op);
    applyOp(engine, tokens, op);
  };

  emit(g.create());
  while (scenario.ops.length < opCount) {
    const roll = r.next();
    // Keep a live curve around: once every token has graduated, curve ops can
    // only hit AlreadyGraduated, which one op in twenty covers already.
    const anyLive = tokens.some((t) => !engine.pool(t)?.graduated);
    if ((roll < 0.06 || !anyLive) && tokens.length < MAX_TOKENS) emit(g.create());
    else if (roll < 0.42) emit(g.curveBuy());
    else if (roll < 0.62) emit(g.curveSell());
    else if (roll < 0.8) emit(g.ammTrade());
    else if (roll < 0.84) emit(g.graduate());
    else if (roll < 0.89) emit(g.feeChange());
    else emit(g.pushToGraduation());
  }
  return scenario;
}

/** Op builders, each reading the engine's current state to pick meaningful values. */
class Aim {
  readonly #r: Rng;
  readonly #e: Engine;
  readonly #tokens: TokenId[];
  readonly #users: number;

  constructor(r: Rng, e: Engine, tokens: TokenId[], users: number) {
    this.#r = r;
    this.#e = e;
    this.#tokens = tokens;
    this.#users = users;
  }

  create(): ParityOp {
    const r = this.#r;
    const fee = this.#e.fees.creationFee;
    const user = r.int(this.#users);
    const roll = r.next();
    if (roll < 0.05 && fee > 0n) return this.#op(Op.Create, user, 0, fee - 1n, 0n); // InsufficientCreationFee
    if (roll < 0.1) return this.#op(Op.Create, user, 0, fee, 1n); // asks for tokens, buys none: Slippage
    if (roll < 0.45) return this.#op(Op.Create, user, 0, fee, 0n); // no initial buy
    return this.#op(Op.Create, user, 0, fee + r.logUniform(9, 18.3), 0n);
  }

  curveBuy(): ParityOp | null {
    const r = this.#r;
    const t = this.#pickToken(r.chance(0.95) ? "live" : "any");
    if (t === null) return null;
    const user = r.int(this.#users);
    if (r.chance(0.05)) return this.#op(Op.Buy, user, t, 0n, 0n); // ZeroAmount
    const value = r.logUniform(0, 18.3); // 1 wei up to ~2 ETH, including sub-token dust
    return this.#op(Op.Buy, user, t, value, this.#buyMin(t, value));
  }

  curveSell(): ParityOp | null {
    const r = this.#r;
    const t = this.#pickToken(r.chance(0.95) ? "live" : "any");
    if (t === null) return null;
    const user = this.#holder(t);
    const held = this.#e.balance(userId(user), this.#tokenId(t));
    const amount = this.#portion(held);
    let min = 0n;
    const pool = this.#e.pool(this.#tokenId(t));
    if (pool && !pool.graduated && amount > 0n && amount <= pool.tokensSold) {
      const quoted = this.#e.quoteSell(this.#tokenId(t), amount).quoteOut;
      const roll = r.next();
      if (roll < 0.1) min = quoted;
      else if (roll < 0.2) min = quoted + 1n; // Slippage
    }
    return this.#op(Op.Sell, user, t, amount, min);
  }

  ammTrade(): ParityOp | null {
    const r = this.#r;
    const graduated = this.#tokens.map((id, i) => [id, i] as const).filter(([id]) => this.#e.pool(id)?.graduated);
    // Mostly trade a graduated pool; sometimes hit an ungraduated one for PairNotFound.
    const target = graduated.length > 0 && r.chance(0.9) ? r.pick(graduated)[1] : this.#pickToken("any");
    if (target === null) return null;
    const id = this.#tokenId(target);
    const user = r.int(this.#users);

    if (r.chance(0.5)) {
      const value = r.chance(0.04) ? 0n : r.logUniform(0, 18.7); // 0 → InsufficientInputAmount
      let min = 0n;
      if (this.#e.pool(id)?.amm && value > 0n) {
        const quoted = this.#e.quoteAmm(id, "buy", value);
        const roll = r.next();
        if (roll < 0.1) min = quoted;
        else if (roll < 0.2) min = quoted + 1n; // InsufficientOutputAmount
      }
      return this.#op(Op.AmmBuy, user, target, value, min);
    }

    const seller = this.#holder(target);
    const amount = this.#portion(this.#e.balance(userId(seller), id));
    let min = 0n;
    if (this.#e.pool(id)?.amm && amount > 0n) {
      const quoted = this.#e.quoteAmm(id, "sell", amount);
      const roll = r.next();
      if (roll < 0.1) min = quoted;
      else if (roll < 0.2) min = quoted + 1n;
    }
    return this.#op(Op.AmmSell, seller, target, amount, min);
  }

  graduate(): ParityOp | null {
    const t = this.#pickToken("any");
    return t === null ? null : this.#op(Op.Graduate, 0, t, 0n, 0n);
  }

  feeChange(): ParityOp {
    const r = this.#r;
    const P = this.#e.params;
    const over = r.chance(0.15); // one past the cap: FeeTooHigh
    switch (r.int(3)) {
      case 0:
        return this.#op(Op.SetTradeFee, 0, 0, over ? P.maxTradeFeeBps + 1n : r.below(P.maxTradeFeeBps), 0n);
      case 1:
        return this.#op(Op.SetGradFee, 0, 0, over ? P.maxGraduationFeeBps + 1n : r.below(P.maxGraduationFeeBps), 0n);
      default:
        return this.#op(Op.SetCreationFee, 0, 0, over ? P.maxCreationFee + 1n : r.below(P.maxCreationFee), 0n);
    }
  }

  /** A buy sized against the threshold: short of it, exactly on it, or through it with a refund. */
  pushToGraduation(): ParityOp | null {
    const r = this.#r;
    const t = this.#pickToken("live");
    if (t === null) return null;
    const pool = this.#e.pool(this.#tokenId(t));
    if (!pool) return null;
    const bps = this.#e.fees.tradeFeeBps;
    const exact = mulDivUp(this.#e.params.graduationQuote - pool.realQuoteRaised, BPS, BPS - bps);
    const roll = r.next();
    const value =
      roll < 0.25 ? exact - 1n - r.below(exact / 1000n)
      : roll < 0.5 ? exact
      : exact + r.logUniform(0, 18.5);
    return this.#op(Op.Buy, r.int(this.#users), t, value > 0n ? value : 1n, 0n);
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  #op(kind: ParityOp["kind"], user: number, token: number, a: bigint, b: bigint): ParityOp {
    const spendsQuote = kind === Op.Create || kind === Op.Buy || kind === Op.AmmBuy;
    if (spendsQuote && a > this.#e.balance(userId(user))) throw new Error("generator produced an unaffordable op");
    return { kind, user, token, a, b };
  }

  #tokenId(i: number): TokenId {
    const id = this.#tokens[i];
    if (id === undefined) throw new Error(`no token ${i}`);
    return id;
  }

  #pickToken(which: "live" | "any"): number | null {
    const indices = this.#tokens
      .map((id, i) => [id, i] as const)
      .filter(([id]) => which === "any" || !this.#e.pool(id)?.graduated)
      .map(([, i]) => i);
    return indices.length === 0 ? null : this.#r.pick(indices);
  }

  /** Slippage bound for a curve buy: usually none, sometimes exactly the quote, sometimes one past it. */
  #buyMin(t: number, value: bigint): bigint {
    const pool = this.#e.pool(this.#tokenId(t));
    if (!pool || pool.graduated) return 0n;
    const quoted = this.#e.quoteBuy(this.#tokenId(t), value).tokensOut;
    const roll = this.#r.next();
    if (roll < 0.1) return quoted;
    if (roll < 0.2) return quoted + 1n;
    return 0n;
  }

  /** Prefer a user who actually holds the token, so sells are real. */
  #holder(t: number): number {
    const id = this.#tokenId(t);
    const holders = [...Array(this.#users).keys()].filter((u) => this.#e.balance(userId(u), id) > 0n);
    return holders.length > 0 && this.#r.chance(0.9) ? this.#r.pick(holders) : this.#r.int(this.#users);
  }

  /** Some part of a holding, never more than all of it. */
  #portion(held: bigint): bigint {
    const r = this.#r;
    const roll = r.next();
    if (held === 0n || roll < 0.04) return 0n;
    if (roll < 0.08) return 1n;
    if (roll < 0.3) return held;
    if (roll < 0.5) return held / 2n;
    return r.below(held);
  }
}
