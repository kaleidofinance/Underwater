/**
 * The HTTP API over the engine, as a pure request → response function, so
 * tests drive it without sockets and main.ts only adapts node:http.
 *
 * Public reads need nothing. Every write, and reading your own account,
 * needs an Ed25519-signed request (auth.ts). Amounts are decimal strings in
 * both directions.
 */
import { timingSafeEqual } from "node:crypto";
import {
  CHAIN,
  ammFee,
  creatorShare,
  Engine,
  EngineError,
  FEES,
  LOSS,
  QUOTE,
  snapshotLiabilities,
  TAX_FIELDS,
  type TokenTax,
  type LiabilityTree,
  type TokenId,
} from "../engine/index.ts";
import { parseAnchorMemo, type Rails } from "../rails/rails.ts";
import type { SimChain } from "../rails/sim.ts";
import type { ReserveInfo } from "../rails/wallet.ts";
import { authenticate } from "./auth.ts";
import { IMAGE_PATH, ImageStore } from "./images.ts";
import { Market, toPrice, type TradeRow } from "./market.ts";

export interface ApiRequest {
  readonly method: string;
  /** Path including the query string, exactly as signed. */
  readonly path: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  /** Set for binary responses (images); `body` is ignored then. */
  readonly raw?: { readonly bytes: Uint8Array; readonly type: string };
}

export interface AppOptions {
  readonly engine: Engine;
  readonly rails: Rails;
  readonly market: Market;
  /** Present only in local dev: enables POST /api/dev/faucet. */
  readonly sim?: SimChain;
  /** Token images. Defaults to an in-memory store. */
  readonly images?: ImageStore;
  /** Bearer token for operator routes (resume withdrawals). Unset: those routes don't exist. */
  readonly adminToken?: string;
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;
/** Routes that need a signature. Anything else that isn't a public read is a 404, not a 401. */
const PRIVATE_ROUTES = new Set([
  "GET me",
  "GET me/proof",
  "POST me/address",
  "POST tokens",
  "POST trade",
  "POST withdrawals",
  "POST images",
  "POST dividends",
  "POST dev/faucet",
]);
const LIMITS = { name: 32, symbol: 10, metadataURI: 512 };

export class App {
  readonly engine: Engine;
  readonly rails: Rails;
  readonly market: Market;
  readonly images: ImageStore;
  readonly #sim: SimChain | undefined;
  readonly #adminToken: string | undefined;
  readonly #now: () => number;
  readonly #seen = new Map<string, number>();
  #reserves: { at: number; value: unknown } | null = null;
  #tree: { length: number; tree: LiabilityTree } | null = null;
  /** Fixed for the life of the wallet, so fetched once. */
  #reserveInfo: ReserveInfo | null = null;

  constructor(opts: AppOptions) {
    this.engine = opts.engine;
    this.rails = opts.rails;
    this.market = opts.market;
    this.images = opts.images ?? new ImageStore(null);
    this.#sim = opts.sim;
    this.#adminToken = opts.adminToken && opts.adminToken.length >= 32 ? opts.adminToken : undefined;
    this.#now = opts.now ?? Date.now;
  }

  async handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      this.market.catchUp(this.engine);
      const url = new URL(req.path, "http://api.local");
      const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
      if (parts[0] !== "api") return notFound();
      const [, a, b, c] = parts;
      const m = req.method.toUpperCase();

      // ─── Public ─────────────────────────────────────────────────────────
      if (m === "GET") {
        if (a === "health" && !b) return ok({ ok: true, tokens: this.engine.tokens.length, log: this.engine.chain.length });
        if (a === "tokens" && !b) return ok(this.#tokenList());
        if (a === "tokens" && b && !c) return ok(this.#tokenDetail(b));
        if (a === "tokens" && b && c === "trades") return ok(this.market.trades(b, clampInt(url.searchParams.get("limit"), 1, 500, 100)).map(tradeWire));
        if (a === "tokens" && b && c === "candles") {
          this.#token(b);
          return ok(this.market.candles(b, clampInt(url.searchParams.get("interval"), 1, 86_400, 60)));
        }
        if (a === "quote" && !b) return ok(this.#quote(url.searchParams));
        if (a === "stats" && !b) return ok(this.#stats());
        if (a === "reserves" && !b) return ok(await this.#reservesCached());
        if (a === "solvency" && !b) return ok(await this.#solvency());
        if (a === "audit" && !b) return ok(await this.#audit());
        if (a === "images" && b && !c) {
          const image = this.images.get(b);
          return image ? { status: 200, body: null, raw: image } : notFound();
        }
      }

      // ─── Operator ───────────────────────────────────────────────────────
      if (a === "admin") {
        if (!this.#adminToken) return notFound();
        const given = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!sameToken(given, this.#adminToken)) return { status: 401, body: { error: "Unauthorized" } };
        if (m === "POST" && b === "withdrawals" && !c) {
          const body = parseBody(req.body);
          if (typeof body.paused !== "boolean") throw new EngineError("InvalidArgument", "paused must be true or false");
          this.engine.setWithdrawalsPaused(body.paused, str(body, "reason", 300));
          return ok({ paused: this.engine.withdrawalsPaused });
        }
        return notFound();
      }

      // ─── Authenticated ──────────────────────────────────────────────────
      const route = `${m} ${[a, b].filter(Boolean).join("/")}`;
      if (!PRIVATE_ROUTES.has(route) || c) return notFound();
      const auth = authenticate(req.headers, m, req.path, req.body, this.#now(), this.#seen);
      if (!auth.ok) return { status: 401, body: { error: "Unauthorized", message: auth.reason } };
      const me = auth.account;
      const body = parseBody(req.body);

      if (m === "GET" && a === "me" && !b) return ok(this.#me(me));
      if (m === "GET" && a === "me" && b === "proof") {
        const proof = this.#liabilities().proof(me);
        if (!proof) throw new EngineError("UnknownId", "no balance to prove yet: deposit first");
        return ok(wire(proof));
      }
      if (m === "POST" && a === "me" && b === "address") {
        return ok({ address: await this.rails.depositAddress(me) });
      }
      if (m === "POST" && a === "tokens" && !b) {
        const name = str(body, "name", LIMITS.name);
        const symbol = str(body, "symbol", LIMITS.symbol);
        const metadataURI = str(body, "metadataURI", LIMITS.metadataURI, true);
        // Only images we host: an outside URL would let its host log every
        // visitor who sees the token, and change or pull the picture later.
        const own = IMAGE_PATH.exec(metadataURI);
        if (metadataURI !== "" && !(own?.[1] && this.images.has(own[1]))) {
          throw new EngineError("InvalidArgument", "the image must be uploaded through /api/images first");
        }
        const r = this.engine.create(me, {
          name,
          symbol,
          metadataURI,
          value: big(body, "value"),
          minTokensOut: big(body, "minTokensOut", true),
          tax: parseTax(body.tax),
        });
        return ok(wire({ token: r.result.token, tokensBought: r.result.tokensBought, seq: r.seq }));
      }
      if (m === "POST" && a === "trade" && !b) return ok(this.#trade(me, body));
      if (m === "POST" && a === "withdrawals" && !b) {
        const id = await this.rails.requestWithdrawal(me, str(body, "address", 512), big(body, "amount"));
        return ok({ withdrawalId: id });
      }
      if (m === "POST" && a === "dividends" && !b) {
        // One token, or every token with something to collect.
        const only = body.token === undefined ? null : str(body, "token", 64);
        const tokens = only ? [only] : this.engine.tokens.filter((id) => this.engine.dividendsOf(id, me) > 0n);
        let claimed = 0n;
        for (const t of tokens) claimed += this.engine.claimDividends(me, t).result;
        return ok({ claimed: claimed.toString() });
      }
      if (m === "POST" && a === "images" && !b) {
        const data = str(body, "data", Math.ceil((this.images.limits.maxBytes * 4) / 3) + 4);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new EngineError("InvalidArgument", "data must be base64");
        const id = this.images.put(me, Buffer.from(data, "base64"), this.#now());
        return ok({ id, uri: `/api/images/${id}` });
      }
      if (m === "POST" && a === "dev" && b === "faucet" && this.#sim) return ok(await this.#faucet(me, body));

      return notFound();
    } catch (err) {
      if (err instanceof EngineError) return { status: 400, body: { error: err.code, message: err.message } };
      if (err instanceof SyntaxError) return { status: 400, body: { error: "BadJson", message: err.message } };
      return { status: 500, body: { error: "Internal", message: (err as Error).message } };
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────

  #token(id: TokenId) {
    const p = this.engine.pool(id);
    if (!p) throw new EngineError("UnknownToken", id);
    return p;
  }

  #summary(id: TokenId) {
    const p = this.#token(id);
    const priceX18 = this.engine.priceX18(id);
    const last = this.market.lastTrade(id);
    return {
      id,
      name: p.name,
      symbol: p.symbol,
      metadataURI: p.metadataURI,
      creator: p.creator,
      creatorEarned: this.market.creatorEarned(id).toString(),
      tax: p.tax ? Object.fromEntries(Object.entries(p.tax).map(([k, v]) => [k, v.toString()])) : null,
      taxTotals: Object.fromEntries(Object.entries(this.market.taxTotals(id)).map(([k, v]) => [k, v.toString()])),
      createdAt: p.createdAt,
      graduated: p.graduated,
      progressBps: this.engine.progressBps(id).toString(),
      priceX18: priceX18.toString(),
      price: toPrice(priceX18),
      marketCap: this.engine.marketCap(id).toString(),
      volume24h: this.market.volume(id, this.#now() - DAY_MS).toString(),
      lastTradeAt: last?.ts ?? null,
    };
  }

  #tokenList() {
    return this.engine.tokens
      .map((id) => this.#summary(id))
      .sort((x, y) => (y.lastTradeAt ?? y.createdAt) - (x.lastTradeAt ?? x.createdAt));
  }

  #tokenDetail(id: TokenId) {
    const p = this.#token(id);
    return {
      ...this.#summary(id),
      curve: {
        quoteReserve: p.quoteReserve.toString(),
        tokenReserve: p.tokenReserve.toString(),
        realQuoteRaised: p.realQuoteRaised.toString(),
        tokensSold: p.tokensSold.toString(),
        graduationQuote: this.engine.params.graduationQuote.toString(),
      },
      amm: p.amm ? { quote: p.amm.quote.toString(), token: p.amm.token.toString() } : null,
      totalSupply: this.engine.totalSupply(id).toString(),
      fees: wire(this.engine.fees),
    };
  }

  #quote(q: URLSearchParams) {
    const token = q.get("token") ?? "";
    const side = q.get("side");
    const amount = big({ amount: q.get("amount") }, "amount");
    const p = this.#token(token);
    if (side === "buy") {
      if (p.graduated) {
        const q = this.engine.quoteAmm(token, "buy", amount);
        return { venue: "amm", out: q.out.toString(), fee: q.fee.toString(), tax: q.tax.toString(), refund: "0" };
      }
      const r = this.engine.quoteBuy(token, amount);
      return {
        venue: "curve",
        out: r.tokensOut.toString(),
        fee: r.fee.toString(),
        tax: r.tax.toString(),
        refund: r.refund.toString(),
      };
    }
    if (side === "sell") {
      if (p.graduated) {
        const q = this.engine.quoteAmm(token, "sell", amount);
        return { venue: "amm", out: q.out.toString(), fee: q.fee.toString(), tax: q.tax.toString(), refund: "0" };
      }
      const r = this.engine.quoteSell(token, amount);
      return { venue: "curve", out: r.quoteOut.toString(), fee: r.fee.toString(), tax: r.tax.toString(), refund: "0" };
    }
    throw new EngineError("InvalidArgument", "side must be buy or sell");
  }

  #stats() {
    const ids = this.engine.tokens;
    const since = this.#now() - DAY_MS;
    return {
      tokens: ids.length,
      graduated: ids.filter((id) => this.engine.pool(id)?.graduated).length,
      volume24h: ids.reduce((s, id) => s + this.market.volume(id, since), 0n).toString(),
      liabilities: (-this.engine.ledger.balance(CHAIN, QUOTE)).toString(),
      protocolFees: this.engine.ledger.balance(FEES, QUOTE).toString(),
      creatorEarned: ids.reduce((s, id) => s + this.market.creatorEarned(id), 0n).toString(),
      withdrawalsPaused: this.engine.withdrawalsPaused,
      loss: (-this.engine.ledger.balance(LOSS, QUOTE)).toString(),
      fees: {
        tradeFeeBps: this.engine.fees.tradeFeeBps.toString(),
        creatorShareBps: creatorShare(this.engine.fees).toString(),
        ammFeeBps: ammFee(this.engine.fees).toString(),
        graduationFeeBps: this.engine.fees.graduationFeeBps.toString(),
        creationFee: this.engine.fees.creationFee.toString(),
      },
    };
  }

  /** Hot wallet vs. ledger, cached briefly: the first public piece of proof of reserves. */
  async #reservesCached() {
    const now = this.#now();
    if (this.#reserves && now - this.#reserves.at < 30_000) return this.#reserves.value;
    const r = await this.rails.reconcile();
    const totals = (t: { total: bigint; spendable: bigint }) => ({ total: t.total.toString(), spendable: t.spendable.toString() });
    const value = {
      ledger: r.expected.toString(),
      wallet: r.actual.toString(),
      drift: r.drift.toString(),
      treasury: totals(r.treasury),
      reserve: totals(r.reserve),
      inFlight: r.inFlight,
      at: now,
    };
    this.#reserves = { at: now, value };
    return value;
  }

  /**
   * Everything needed to audit us without trusting us: the reserve's viewing
   * key (import it into any Zcash wallet to see what the reserve holds) and
   * every hash-chain anchor we've written to it.
   */
  async #audit() {
    this.#reserveInfo ??= await this.rails.wallet.reserveInfo();
    const anchors = this.engine
      .treasuryTxs()
      .filter((t) => t.purpose === "anchor" && t.memo)
      .map((t) => ({ ...parseAnchorMemo(t.memo ?? ""), txid: t.txid, state: t.state, at: t.submittedAt }))
      .reverse();
    return {
      reserve: this.#reserveInfo,
      anchors,
      sweeps: this.engine.treasuryTxs().filter((t) => t.purpose === "sweep").length,
    };
  }

  /** The liability tree for the engine as it is now, rebuilt only after a command lands. */
  #liabilities(): LiabilityTree {
    const length = this.engine.chain.length;
    if (!this.#tree || this.#tree.length !== length) this.#tree = { length, tree: snapshotLiabilities(this.engine) };
    return this.#tree.tree;
  }

  /** Both halves of solvency in one place: what's owed (root) and what's held (reserves). */
  async #solvency() {
    const tree = this.#liabilities();
    const [seq, head] = tree.snapshot.split(":");
    return {
      snapshot: { seq: Number(seq), head, root: tree.root.hash, liabilities: tree.root.sum.toString(), leaves: tree.size },
      reserves: await this.#reservesCached(),
    };
  }

  #me(me: string) {
    const holdings = this.engine.tokens
      .map((id) => ({ token: id, symbol: this.engine.pool(id)?.symbol ?? "", amount: this.engine.balance(me, id) }))
      .filter((h) => h.amount > 0n);
    // Tokens this account launched, and what their trading fees have paid it.
    const launched = this.engine.tokens
      .filter((id) => this.engine.pool(id)?.creator === me)
      .map((id) => ({ token: id, symbol: this.engine.pool(id)?.symbol ?? "", earned: this.market.creatorEarned(id) }));
    const dividends = this.engine.tokens
      .map((id) => ({ token: id, symbol: this.engine.pool(id)?.symbol ?? "", amount: this.engine.dividendsOf(id, me) }))
      .filter((d) => d.amount > 0n);
    return wire({
      account: me,
      balance: this.engine.balance(me),
      withdrawable: this.engine.withdrawable(me),
      immature: this.engine.immatureBalance(me),
      depositAddress: this.engine.addressOf(me)?.address ?? null,
      holdings,
      launched,
      dividends,
      deposits: this.engine.depositRecords().filter((d) => d.user === me),
      withdrawals: this.engine.withdrawalRecords().filter((w) => w.user === me),
      withdrawalFee: this.rails.policy.withdrawalFee,
      withdrawalLimit: this.rails.withdrawalAllowance(me),
      minWithdrawal: this.rails.policy.minWithdrawal,
      minDeposit: this.rails.policy.minDeposit,
    });
  }

  // ─── Writes ───────────────────────────────────────────────────────────

  /** One trade endpoint: the curve before graduation, the built-in DEX after. */
  #trade(me: string, body: Record<string, unknown>) {
    const token = str(body, "token", 64);
    const side = body.side;
    const amount = big(body, "amount");
    const minOut = big(body, "minOut", true);
    const p = this.#token(token);
    let out: bigint;
    if (side === "buy") {
      out = p.graduated
        ? this.engine.swapQuoteForTokens(me, token, amount, minOut).result
        : this.engine.buy(me, token, amount, minOut).result;
    } else if (side === "sell") {
      out = p.graduated
        ? this.engine.swapTokensForQuote(me, token, amount, minOut).result
        : this.engine.sell(me, token, amount, minOut).result;
    } else {
      throw new EngineError("InvalidArgument", "side must be buy or sell");
    }
    this.market.catchUp(this.engine);
    return wire({ out, venue: p.graduated ? "amm" : "curve", graduated: this.engine.pool(token)?.graduated ?? false });
  }

  /** Local dev only: pay the caller's deposit address on the simulated chain and confirm it. */
  async #faucet(me: string, body: Record<string, unknown>) {
    const sim = this.#sim;
    if (!sim) throw new EngineError("InvalidState", "no faucet outside sim mode");
    const amount = body.amount === undefined ? 100_000_000n : big(body, "amount");
    await this.rails.depositAddress(me);
    const index = this.engine.addressOf(me)?.index ?? -1;
    sim.receive(index, amount);
    sim.mine(this.rails.policy.finalityDepth);
    await this.rails.tick();
    return wire({ balance: this.engine.balance(me), withdrawable: this.engine.withdrawable(me) });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const notFound = (): ApiResponse => ({ status: 404, body: { error: "NotFound" } });

/** Deep-convert bigints to decimal strings for JSON. */
export function wire(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(wire);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, wire(v)]));
  }
  return value;
}

function tradeWire(t: TradeRow) {
  return { ...(wire(t) as object), price: toPrice(t.priceX18) };
}

function parseBody(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new EngineError("InvalidArgument", "body must be a JSON object");
  return v as Record<string, unknown>;
}

/** A launch's tax, from `{ buyBps, sellBps, creatorBps, dividendsBps, buybackBps, liquidityBps }` as decimal strings. The engine validates it. */
function parseTax(raw: unknown): TokenTax | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw new EngineError("InvalidArgument", "tax must be an object");
  const o = raw as Record<string, unknown>;
  const field = (k: (typeof TAX_FIELDS)[number]) => big(o, k, true);
  return {
    buyBps: field("buyBps"),
    sellBps: field("sellBps"),
    creatorBps: field("creatorBps"),
    dividendsBps: field("dividendsBps"),
    buybackBps: field("buybackBps"),
    liquidityBps: field("liquidityBps"),
  };
}

/** Constant-time comparison, so response timing can't leak the token byte by byte. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function big(body: Record<string, unknown>, key: string, optional = false): bigint {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (optional) return 0n;
    throw new EngineError("InvalidArgument", `${key} is required`);
  }
  if (typeof v !== "string" || !/^\d{1,40}$/.test(v)) throw new EngineError("InvalidArgument", `${key} must be a decimal string`);
  return BigInt(v);
}

function str(body: Record<string, unknown>, key: string, max: number, optional = false): string {
  const v = body[key];
  if (v === undefined || v === null) {
    if (optional) return "";
    throw new EngineError("InvalidArgument", `${key} is required`);
  }
  if (typeof v !== "string" || v.length > max) throw new EngineError("InvalidArgument", `${key} must be a string of at most ${max} characters`);
  return v;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

