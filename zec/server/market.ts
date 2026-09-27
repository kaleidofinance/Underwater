/**
 * Market data derived from the engine's own command log: trades, candles,
 * volume. Nothing here is stored separately. It's a read model rebuilt by
 * walking the hash chain, so it can never disagree with the ledger, and a
 * restart rebuilds it exactly.
 */
import { E18, type Engine, type EngineEvent, type TokenId } from "../engine/index.ts";

export interface TradeRow {
  readonly seq: number;
  readonly ts: number;
  readonly token: TokenId;
  readonly trader: string;
  readonly side: "buy" | "sell";
  readonly venue: "curve" | "amm";
  readonly quote: bigint;
  readonly tokens: bigint;
  readonly fee: bigint;
  /** Marginal price after the trade: quote base units per whole token, × 1e18. */
  readonly priceX18: bigint;
}

export interface Candle {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Quote volume in whole quote units (ZEC). */
  readonly volume: number;
}

type Listener = (trades: readonly TradeRow[], events: readonly EngineEvent[]) => void;

/** priceX18 → ZEC per token, as a float for charts. Exact values stay in priceX18. */
export function toPrice(priceX18: bigint, quoteDecimals = 8): number {
  return Number(priceX18) / 1e18 / 10 ** quoteDecimals;
}

export class Market {
  #next = 0;
  readonly #trades = new Map<TokenId, TradeRow[]>();
  /** What each token's creator has earned from its trade fees, in zatoshi. */
  readonly #creatorEarned = new Map<TokenId, bigint>();
  readonly #listeners = new Set<Listener>();

  /** Absorb every record committed since the last call. Cheap; call it freely. */
  catchUp(engine: Engine): void {
    const records = engine.chain.records;
    if (this.#next >= records.length) return;
    const newTrades: TradeRow[] = [];
    const newEvents: EngineEvent[] = [];
    for (let i = this.#next; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const body = record.body as { ts: number; events: readonly EngineEvent[] };
      for (const ev of body.events) {
        newEvents.push(ev);
        if (ev.type === "CreatorFee") {
          this.#creatorEarned.set(ev.token, (this.#creatorEarned.get(ev.token) ?? 0n) + ev.amount);
          continue;
        }
        if (ev.type !== "Trade") continue;
        const row: TradeRow = {
          seq: record.seq,
          ts: body.ts,
          token: ev.token,
          trader: ev.trader,
          side: ev.isBuy ? "buy" : "sell",
          venue: ev.venue,
          quote: ev.quoteAmount,
          tokens: ev.tokenAmount,
          fee: ev.fee,
          priceX18: ev.tokenReserve === 0n ? 0n : (ev.quoteReserve * E18 * E18) / ev.tokenReserve,
        };
        const list = this.#trades.get(ev.token) ?? [];
        list.push(row);
        this.#trades.set(ev.token, list);
        newTrades.push(row);
      }
    }
    this.#next = records.length;
    if (newEvents.length > 0) for (const l of this.#listeners) l(newTrades, newEvents);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  trades(token: TokenId, limit = 100): TradeRow[] {
    const all = this.#trades.get(token) ?? [];
    return all.slice(-limit).reverse();
  }

  /** Quote volume since `sinceMs`. */
  volume(token: TokenId, sinceMs: number): bigint {
    let v = 0n;
    const all = this.#trades.get(token) ?? [];
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i];
      if (!t || t.ts < sinceMs) break;
      v += t.quote;
    }
    return v;
  }

  creatorEarned(token: TokenId): bigint {
    return this.#creatorEarned.get(token) ?? 0n;
  }

  lastTrade(token: TokenId): TradeRow | undefined {
    return this.#trades.get(token)?.at(-1);
  }

  /** OHLCV buckets of `intervalSec`. Each candle opens at the previous close, so the chart has no gaps in price. */
  candles(token: TokenId, intervalSec: number, limit = 500): Candle[] {
    const out: Candle[] = [];
    let prevClose: number | null = null;
    for (const t of this.#trades.get(token) ?? []) {
      const time = Math.floor(t.ts / 1000 / intervalSec) * intervalSec;
      const price = toPrice(t.priceX18);
      const vol = Number(t.quote) / 1e8;
      const last = out.at(-1);
      if (last && last.time === time) {
        out[out.length - 1] = {
          ...last,
          high: Math.max(last.high, price),
          low: Math.min(last.low, price),
          close: price,
          volume: last.volume + vol,
        };
      } else {
        const open = prevClose ?? price;
        out.push({ time, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: vol });
      }
      prevClose = price;
    }
    return out.slice(-limit);
  }
}
