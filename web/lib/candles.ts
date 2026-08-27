import type { Trade } from "./trades";

/**
 * Trades → candles.
 *
 * The feed hands back one row per trade, each carrying the price the trade *left
 * behind*. That is a tick series, and a candlestick chart wants OHLC buckets, so
 * this is the bucketing — kept out of the chart component because it is pure
 * arithmetic over the feed and is much easier to reason about (and to correct)
 * away from any SVG.
 *
 * Two details that matter for honesty:
 *
 * - A bucket's **open is the previous bucket's close**, not its own first tick.
 *   Our ticks are post-trade prices, so the price the market opened this bucket at
 *   is the one the last bucket ended at; taking the first tick as the open would
 *   silently swallow the first move of every bucket. The open is folded into the
 *   high/low for the same reason — otherwise a candle could print a body outside
 *   its own wick.
 * - **Empty buckets are drawn, flat.** A gap in trading is information; skipping
 *   quiet buckets would compress the time axis and make a token that traded twice
 *   in an hour look like it traded continuously.
 *
 * Rows whose block timestamp has not arrived yet are dropped: a candle chart is
 * indexed by clock time, and guessing a timestamp from a block number would put
 * bars in places nothing happened.
 */

export type Timeframe = {
  key: string;
  label: string;
  seconds: number;
};

/** The offered timeframes, coarsest last. */
export const TIMEFRAMES: readonly Timeframe[] = [
  { key: "1m", label: "1m", seconds: 60 },
  { key: "5m", label: "5m", seconds: 5 * 60 },
  { key: "15m", label: "15m", seconds: 15 * 60 },
  { key: "1h", label: "1h", seconds: 60 * 60 },
  { key: "4h", label: "4h", seconds: 4 * 60 * 60 },
  { key: "1d", label: "1D", seconds: 24 * 60 * 60 },
] as const;

export type Candle = {
  /** Bucket start, unix seconds. */
  time: number;
  /** All four in gwei per token, the unit the rest of the chart uses. */
  open: number;
  high: number;
  low: number;
  close: number;
  /** Gross ETH the bucket moved, in wei. */
  volume: bigint;
  trades: number;
  /** No trade landed here — carried forward from the last close. */
  empty: boolean;
  /** The curve handed over to a pool inside this bucket. */
  graduated: boolean;
};

/**
 * How many bars the chart will draw. Past this the bodies are thinner than the
 * hairlines they sit on, so the oldest are dropped rather than drawn as mush —
 * `buildCandles` reports the drop through {@link Candles.truncated} so the panel
 * can say so instead of quietly showing a shorter history than it scanned.
 */
export const MAX_CANDLES = 90;

export type Candles = {
  candles: Candle[];
  /** Buckets dropped off the front because the series was longer than MAX_CANDLES. */
  truncated: number;
  /** Feed rows ignored because their block timestamp had not arrived yet. */
  pending: number;
};

const gwei = (priceE18: bigint) => Number(priceE18) / 1e9;

/** Bucket a tick series into OHLCV candles of `seconds` each. */
export function buildCandles(
  trades: readonly Trade[],
  seconds: number,
  maxCandles = MAX_CANDLES,
): Candles {
  const usable = trades.filter((t) => t.timestamp !== null && t.priceE18 > 0n);
  const pending = trades.filter((t) => t.timestamp === null).length;
  if (usable.length === 0) return { candles: [], truncated: 0, pending };

  // Clock order, not log order: the two agree in practice, but the buckets are
  // keyed on time and a single out-of-order row would open a bucket in the past.
  const rows = [...usable].sort(
    (a, b) =>
      (a.timestamp as number) - (b.timestamp as number) ||
      Number(a.block - b.block) ||
      a.logIndex - b.logIndex,
  );

  const floor = (ts: number) => Math.floor(ts / seconds) * seconds;

  type Bucket = { ticks: number[]; volume: bigint; trades: number; pool: boolean; curve: boolean };
  const buckets = new Map<number, Bucket>();
  for (const t of rows) {
    const at = floor(t.timestamp as number);
    let b = buckets.get(at);
    if (!b) {
      b = { ticks: [], volume: 0n, trades: 0, pool: false, curve: false };
      buckets.set(at, b);
    }
    b.ticks.push(gwei(t.priceE18));
    b.volume += t.ethAmount;
    b.trades += 1;
    if (t.venue === "pool") b.pool = true;
    else b.curve = true;
  }

  const first = floor(rows[0].timestamp as number);
  const last = floor(rows[rows.length - 1].timestamp as number);
  const total = Math.floor((last - first) / seconds) + 1;

  // Walk every bucket in the span so the gaps are drawn, then keep the newest
  // MAX_CANDLES. The walk starts at the beginning even when the head will be
  // dropped, because each candle's open is the one before it's close — starting
  // mid-series would invent an open for the first bar kept.
  const all: Candle[] = [];
  let prevClose: number | null = null;
  let seenCurve = false;
  let markedGrad = false;
  for (let i = 0; i < total; i++) {
    const at = first + i * seconds;
    const b = buckets.get(at);
    if (!b) {
      const flat = prevClose ?? 0;
      all.push({
        time: at,
        open: flat,
        high: flat,
        low: flat,
        close: flat,
        volume: 0n,
        trades: 0,
        empty: true,
        graduated: false,
      });
      continue;
    }
    const open = prevClose ?? b.ticks[0];
    const close = b.ticks[b.ticks.length - 1];
    // The hand-over bucket: the first pool swap, given the curve traded before it
    // — `b.curve` included because the graduating buy and the first pool swap can
    // land in the same bucket. Marked once; a launch whose whole visible history
    // is already in the pool never graduated inside this window, so it gets no
    // marker at all.
    const graduated = b.pool && (seenCurve || b.curve) && !markedGrad;
    if (graduated) markedGrad = true;
    if (b.curve) seenCurve = true;
    all.push({
      time: at,
      open,
      close,
      high: Math.max(open, ...b.ticks),
      low: Math.min(open, ...b.ticks),
      volume: b.volume,
      trades: b.trades,
      empty: false,
      graduated,
    });
    prevClose = close;
  }

  const truncated = Math.max(0, all.length - maxCandles);
  return { candles: all.slice(truncated), truncated, pending };
}

/**
 * The coarsest-but-tightest timeframe that fits the whole history on screen —
 * the default, so a token that has traded for ten minutes opens on 1m bars and
 * one that has traded for a month opens on daily.
 */
export function autoTimeframe(trades: readonly Trade[]): Timeframe {
  const stamps = trades
    .map((t) => t.timestamp)
    .filter((t): t is number => t !== null);
  if (stamps.length < 2) return TIMEFRAMES[0];
  const span = Math.max(...stamps) - Math.min(...stamps);
  return (
    TIMEFRAMES.find((tf) => span / tf.seconds <= MAX_CANDLES) ??
    TIMEFRAMES[TIMEFRAMES.length - 1]
  );
}
