"use client";

import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type HistogramData,
  HistogramSeries,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Seg } from "@/components/Seg";
import {
  autoTimeframe,
  buildCandles,
  TIMEFRAMES,
  type Candle,
} from "@/lib/candles";
import { CURVE } from "@/lib/contracts";
import { spotPriceE18 } from "@/lib/curve";
import type { PoolQuote } from "@/lib/dex";
import { fmtAge, fmtEth } from "@/lib/format";
import type { Pool } from "@/lib/hooks";
import { chronological, ROWS, type Trade, type TradeFeed } from "@/lib/trades";

/**
 * The plate: what this token costs, drawn two ways.
 *
 * **Price** is the realised history — every trade at both venues, priced off the
 * reserves each one left behind, so the line is the actual chain state and not a
 * smoothed average. **Curve** is the shape the launchpad guarantees: price
 * against ETH raised, 1 gwei to 25, with this launch's position on it.
 *
 * Both matter and neither replaces the other. A launch with three trades has no
 * price history worth looking at but a completely knowable future, which is the
 * whole appeal of a bonding curve — so the curve is what a quiet token shows,
 * and the moment there is history to read the chart opens on that instead.
 *
 * An imported token has no curve and so gets neither the tab nor the fallback: what
 * it costs is whatever its pool says, and there is no guaranteed shape to promise
 * beside it. See `isImported`.
 *
 * The candles are rendered with lightweight-charts (TradingView's canvas library),
 * so that view has the zoom, pan and crosshair a trader expects — see
 * {@link LightweightCandles}, which reads the app's own CSS variables so the
 * canvas keeps the palette. The price line and the curve stay hand-drawn SVG:
 * both are a shape rather than a tradable history, a few dozen lines of geometry
 * that want no interaction and would only be a themeing fight in a library.
 */

const W = 720;
const H = 268;
const PAD = { l: 52, r: 18, t: 16, b: 24 };
const PLOT = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };

/** The curve's invariant: virtual ETH times the whole supply. */
const K = CURVE.virtualEth * CURVE.totalSupply;
const GRAD_ETH = Number(CURVE.graduationEth) / 1e18;

/** Price at a given amount raised, by the same arithmetic as the contract. */
function curvePriceAt(raise: bigint): bigint {
  const eth = CURVE.virtualEth + raise;
  return spotPriceE18(eth, K / eth);
}

const gwei = (priceE18: bigint) => Number(priceE18) / 1e9;

type View = "candles" | "price" | "curve";

export function PriceChart({
  symbol,
  pool,
  pair,
  priceE18,
  feed,
}: {
  symbol: string;
  /**
   * Null for an imported token, which has no curve to draw and therefore no third
   * view — see `isImported`. Everything else on this panel is the realised history
   * and reads the same either way.
   */
  pool: Pool | null;
  pair: PoolQuote | undefined;
  /** The live price, whichever venue it currently comes from. */
  priceE18: bigint;
  feed: TradeFeed;
}) {
  const [chosen, setChosen] = useState<View | null>(null);

  const points = useMemo(
    () => chronological(feed.trades).filter((t) => t.priceE18 > 0n),
    [feed.trades],
  );

  // Falls back to the curve until there is a history to plot, but a deliberate
  // choice sticks — otherwise the tab would flip under the cursor the moment a
  // second trade landed. Candles are the default read once there is history: the
  // line is kept because a token with three trades has no candles worth seeing.
  //
  // With no curve there is nothing to fall back *to*, so candles are the only
  // answer — including for a pool with no trades yet, which then renders its own
  // empty state. `chosen` cannot be `"curve"` in that case: neither the tabs below
  // nor `onCurve` offers it.
  const view: View = chosen ?? (pool && points.length < 2 ? "curve" : "candles");

  // Handed down so the empty and error states can offer the curve as somewhere to
  // go, and withheld when there is no curve — an imported pool with no history says
  // only that, instead of a button that would show a shape it does not follow.
  const onCurve = pool ? () => setChosen("curve") : undefined;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>
          {view === "curve"
            ? "The curve"
            : view === "candles"
              ? "Candles"
              : "Price"}
        </span>
        <span className="dim">
          {view !== "curve"
            ? // Same phrasing as the list below it, off the same feed: two panels
              // reading from one scan should not describe its depth differently.
              `${points.length} trade${points.length === 1 ? "" : "s"} · ${
                feed.complete ? "all of them" : "newest first"
              }`
            : `1 → 25 gwei · ${fmtEth(CURVE.graduationEth)} ETH`}
        </span>
      </div>

      <div className="tabs">
        {(
          [
            ["candles", "Candles"],
            ["price", "Price"],
            // Last, and only where there is one. An imported pool never had a curve,
            // so the tab is absent rather than disabled: a control that cannot do
            // anything is worse than no control.
            ...(pool ? ([["curve", "Curve"]] as const) : []),
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            data-active={view === key}
            onClick={() => setChosen(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "candles" ? (
        <CandleChart
          points={points}
          symbol={symbol}
          loading={feed.isLoading}
          error={feed.error}
          onCurve={onCurve}
          feed={feed}
        />
      ) : view === "price" ? (
        <PriceHistory
          points={points}
          symbol={symbol}
          loading={feed.isLoading}
          error={feed.error}
          onCurve={onCurve}
        />
      ) : pool ? (
        <CurvePlate pool={pool} pair={pair} priceE18={priceE18} />
      ) : null}
    </div>
  );
}

/// ─── Price against ETH raised: the shape, and where this launch sits on it ──

function CurvePlate({
  pool,
  pair,
  priceE18,
}: {
  pool: Pool;
  pair: PoolQuote | undefined;
  priceE18: bigint;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  // `realEthRaised` is zeroed at graduation — the ETH has left the contract —
  // so a graduated launch is at the end of the curve by definition, not at 0.
  const raised = pool.graduated ? CURVE.graduationEth : pool.realEthRaised;
  const at = Math.min(GRAD_ETH, Number(raised) / 1e18);

  const gradPrice = gwei(curvePriceAt(CURVE.graduationEth));
  const xMax = GRAD_ETH * 1.08;
  const yMax = gradPrice * 1.14;

  const x = (eth: number) => PAD.l + (eth / xMax) * PLOT.w;
  const y = (g: number) => PAD.t + PLOT.h - (g / yMax) * PLOT.h;

  // Sampled rather than expressed as a Bézier: the samples come out of the same
  // integer arithmetic the contract uses, so the line cannot flatter the curve.
  const samples = useMemo(() => {
    const out: { eth: number; g: number }[] = [];
    for (let i = 0; i <= 96; i++) {
      const raise = (CURVE.graduationEth * BigInt(i)) / 96n;
      out.push({ eth: Number(raise) / 1e18, g: gwei(curvePriceAt(raise)) });
    }
    return out;
  }, []);

  const line = (rows: { eth: number; g: number }[]) =>
    rows.map((p) => `${x(p.eth).toFixed(1)},${y(p.g).toFixed(1)}`).join(" ");

  const travelled = samples.filter((p) => p.eth <= at);
  // The exact endpoint, so the gold line ends at the marker rather than at the
  // last sample before it. A graduated launch ends where the curve ended: its
  // live price is the pool's now, which is a different line entirely and is
  // drawn as one below.
  const here = {
    eth: at,
    g: pool.graduated
      ? gradPrice
      : gwei(priceE18) || gwei(curvePriceAt(raised)),
  };
  const filled = [...travelled, here];
  const ahead = [here, ...samples.filter((p) => p.eth > at)];

  const poolPrice = pair && pair.tokenReserve > 0n ? gwei(priceE18) : null;
  const showPool = pool.graduated && poolPrice !== null && poolPrice > 0;

  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Bonding curve from 1 to ${gradPrice.toFixed(0)} gwei over ${GRAD_ETH} ETH raised. This launch has raised ${fmtEth(raised)} ETH.`}
      >
        <defs>
          <linearGradient id={`under${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--sunlit)", stopOpacity: 0.22 }} />
            <stop offset="100%" style={{ stopColor: "var(--sunlit)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>

        <Frame
          yTicks={[0, gradPrice / 2, gradPrice].map((g) => ({
            at: y(g),
            label: tick(g),
          }))}
          xTicks={[0, 1, 2, 3, 4]
            .filter((e) => e <= GRAD_ETH)
            .map((e) => ({ at: x(e), label: `${e}` }))}
          yUnit="gwei per token"
          xUnit="ETH raised"
        />

        {/* Where the curve closes. Drawn under the line so the line wins. */}
        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={y(gradPrice)}
          y2={y(gradPrice)}
          style={{ stroke: "var(--goldleaf)", strokeWidth: 1, strokeDasharray: "3 4", opacity: 0.7 }}
        />
        <text
          x={W - PAD.r}
          y={y(gradPrice) - 6}
          textAnchor="end"
          className="chart-t"
          style={{ fill: "var(--goldleaf)" }}
        >
          graduation · {tick(gradPrice)} gwei
        </text>

        <polygon
          points={`${x(0)},${y(0)} ${line(filled)} ${x(at).toFixed(1)},${y(0)}`}
          style={{ fill: `url(#under${uid})` }}
        />

        {/* What is left to travel, then what has been. */}
        <polyline
          points={line(ahead)}
          style={{
            fill: "none",
            stroke: "var(--ink)",
            strokeWidth: 1,
            strokeDasharray: "2 4",
            opacity: 0.42,
          }}
        />
        {/* The travelled part of the curve, inked in on first paint.
            `pathLength="1"` lets the draw-in be expressed as fractions of the
            line's own length, so one rule in globals.css covers this and the
            history line below without either knowing its own geometry. */}
        <polyline
          className="chart-draw"
          pathLength="1"
          points={line(filled)}
          style={{ fill: "none", stroke: "var(--goldleaf)", strokeWidth: 1.6 }}
        />

        {/* The step down at graduation: 5% of the raise is taken as the protocol
            fee before the pool is seeded, so the pool opens below the price the
            curve closed at. Worth drawing rather than explaining. */}
        {showPool && poolPrice !== null && (
          <>
            <line
              x1={x(GRAD_ETH)}
              x2={x(GRAD_ETH)}
              y1={y(gradPrice)}
              y2={y(poolPrice)}
              style={{ stroke: "var(--sell)", strokeWidth: 1, strokeDasharray: "2 3" }}
            />
            <line
              x1={PAD.l}
              x2={x(GRAD_ETH)}
              y1={y(poolPrice)}
              y2={y(poolPrice)}
              style={{ stroke: "var(--sunlit)", strokeWidth: 1, strokeDasharray: "3 5", opacity: 0.8 }}
            />
            <circle cx={x(GRAD_ETH)} cy={y(poolPrice)} r={3.4} style={{ fill: "var(--goldleaf)" }} />
            <text
              x={x(GRAD_ETH) - 8}
              y={y(poolPrice) + 13}
              textAnchor="end"
              className="chart-t"
              style={{ fill: "var(--ink)" }}
            >
              pool · {tick(poolPrice)} gwei
            </text>
          </>
        )}

        {!pool.graduated && (
          <>
            <line
              x1={x(at)}
              x2={x(at)}
              y1={y(here.g)}
              y2={y(0)}
              style={{ stroke: "var(--goldleaf)", strokeWidth: 1, strokeDasharray: "2 3", opacity: 0.55 }}
            />
            <circle cx={x(at)} cy={y(here.g)} r={3.4} style={{ fill: "var(--goldleaf)" }} />
            <text
              x={x(at) + (at > GRAD_ETH * 0.62 ? -8 : 8)}
              y={y(here.g) - 8}
              textAnchor={at > GRAD_ETH * 0.62 ? "end" : "start"}
              className="chart-t"
              style={{ fill: "var(--ink)" }}
            >
              now · {fmtEth(raised)} ETH · {tick(here.g)} gwei
            </text>
          </>
        )}
      </svg>

      <p className="field-note">
        Price runs from 1 gwei to {tick(gradPrice)} as buyers fill the curve.
        Every launch follows the same line.
      </p>
    </>
  );
}

/// ─── Price over time: what actually happened ────────────────────────────────

function PriceHistory({
  points,
  symbol,
  loading,
  error,
  onCurve,
}: {
  points: Trade[];
  symbol: string;
  loading: boolean;
  error: unknown;
  /** Absent when there is no curve to send the reader to — see `PriceChart`. */
  onCurve?: () => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  if (error)
    return (
      <p className="note" style={{ fontSize: 12.5 }}>
        This RPC would not serve the log range, so there is no history to draw.
        Trading is unaffected
        {onCurve ? (
          <>
            {" "}
            — <button className="link" type="button" onClick={onCurve}>
              the curve
            </button>{" "}
            still says what any size costs.
          </>
        ) : (
          <> — the pool still quotes every size.</>
        )}
      </p>
    );

  if (points.length === 0)
    return (
      <div className="empty" style={{ padding: "34px 0 30px" }}>
        {loading ? "Sounding…" : "No trades in this window"}
        {!loading && onCurve && (
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={onCurve}>
              Show the curve
            </button>
          </div>
        )}
      </div>
    );

  // Position on chain, not the clock: every row has a block number, while a pool
  // row's timestamp arrives a moment later out of the block. Ink seals a block a
  // second, so on this axis the two are the same picture anyway.
  const blocks = points.map((p) => Number(p.block));
  const prices = points.map((p) => gwei(p.priceE18));
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padY = (hi - lo || hi || 1) * 0.12;
  const yMin = Math.max(0, lo - padY);
  const yMax = hi + padY;
  const b0 = Math.min(...blocks);
  const b1 = Math.max(...blocks);

  const x = (b: number) =>
    PAD.l + (b1 === b0 ? PLOT.w / 2 : ((b - b0) / (b1 - b0)) * PLOT.w);
  const y = (g: number) =>
    PAD.t + PLOT.h - ((g - yMin) / (yMax - yMin || 1)) * PLOT.h;

  const path = points
    .map((p, i) => `${x(blocks[i]).toFixed(1)},${y(prices[i]).toFixed(1)}`)
    .join(" ");

  // Where the curve handed over to the pool, if that happened inside the window.
  const crossing = points.findIndex((p) => p.venue === "pool");
  const grad = crossing > 0 ? blocks[crossing] : null;

  const oldest = points.find((p) => p.timestamp)?.timestamp ?? null;
  const newest = [...points].reverse().find((p) => p.timestamp)?.timestamp ?? null;

  const ends = [
    { at: x(b0), label: oldest ? `${fmtAge(oldest)} ago` : `#${b0}` },
    { at: x(b1), label: newest ? `${fmtAge(newest)} ago` : `#${b1}` },
  ];
  // A history that fits inside one age bucket — everything "2m ago" — would
  // otherwise print the same word at both ends of the axis, which reads as a
  // rendering fault rather than as "all of this happened in one minute".
  const xTicks = ends[0].label === ends[1].label ? [ends[0]] : ends;

  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${points.length} trades, from ${tick(prices[0])} to ${tick(prices[prices.length - 1])} gwei per ${symbol}.`}
      >
        <defs>
          <linearGradient id={`hist${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--sunlit)", stopOpacity: 0.2 }} />
            <stop offset="100%" style={{ stopColor: "var(--sunlit)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>

        <Frame
          yTicks={[yMin, (yMin + yMax) / 2, yMax].map((g) => ({
            at: y(g),
            label: tick(g),
          }))}
          xTicks={xTicks}
          yUnit={`gwei per ${symbol}`}
          xUnit="oldest → newest"
        />

        <polygon
          points={`${x(b0)},${y(yMin)} ${path} ${x(b1)},${y(yMin)}`}
          style={{ fill: `url(#hist${uid})` }}
        />
        <polyline
          className="chart-draw"
          pathLength="1"
          points={path}
          style={{
            fill: "none",
            stroke: "var(--goldleaf)",
            strokeWidth: 1.6,
            strokeLinejoin: "round",
          }}
        />

        {grad !== null && (
          <>
            <line
              x1={x(grad)}
              x2={x(grad)}
              y1={PAD.t}
              y2={PAD.t + PLOT.h}
              style={{ stroke: "var(--goldleaf)", strokeWidth: 1, strokeDasharray: "3 4", opacity: 0.6 }}
            />
            <text x={x(grad) + 5} y={PAD.t + 9} className="chart-t" style={{ fill: "var(--goldleaf)" }}>
              graduated
            </text>
          </>
        )}

        {/* Dots only while they still read as separate trades. */}
        {points.length <= 64 &&
          points.map((p, i) => (
            <circle
              key={p.key}
              cx={x(blocks[i])}
              cy={y(prices[i])}
              r={2.4}
              style={{ fill: p.isBuy ? "var(--goldleaf)" : "var(--sell)" }}
            />
          ))}
      </svg>

      <p className="field-note">
        Each point is one trade. Buys are gold, sells red.
      </p>
    </>
  );
}

/// ─── Candles: OHLC over the clock, with a timeframe ─────────────────────────

/** How the plot area is split between the bars and the volume band beneath. */
/** The height the candlestick canvas is given, matching the SVG plate it replaced. */
const CANDLE_CANVAS_H = H;

function CandleChart({
  points,
  symbol,
  loading,
  error,
  onCurve,
  feed,
}: {
  points: Trade[];
  symbol: string;
  loading: boolean;
  error: unknown;
  /** Absent when there is no curve to send the reader to — see `PriceChart`. */
  onCurve?: () => void;
  feed: TradeFeed;
}) {
  // The tightest timeframe that fits the history, until the reader picks one —
  // then theirs sticks, even as new trades arrive and widen the span.
  const auto = useMemo(() => autoTimeframe(points), [points]);
  const [picked, setPicked] = useState<string | null>(null);
  const tf =
    TIMEFRAMES.find((t) => t.key === picked) ?? auto;

  const { candles, truncated, pending } = useMemo(
    () => buildCandles(points, tf.seconds),
    [points, tf.seconds],
  );

  if (error)
    return (
      <p className="note" style={{ fontSize: 12.5 }}>
        This RPC would not serve the log range, so there are no candles to draw.
        Trading is unaffected
        {onCurve ? (
          <>
            {" "}
            —{" "}
            <button className="link" type="button" onClick={onCurve}>
              the curve
            </button>{" "}
            still says what any size costs.
          </>
        ) : (
          <> — the pool still quotes every size.</>
        )}
      </p>
    );

  if (candles.length === 0)
    return (
      <div className="empty" style={{ padding: "34px 0 30px" }}>
        {loading
          ? "Sounding…"
          : pending > 0
            ? "Timing the blocks…"
            : "No trades in this window"}
        {!loading && pending === 0 && onCurve && (
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={onCurve}>
              Show the curve
            </button>
          </div>
        )}
      </div>
    );

  const last = candles[candles.length - 1];
  const first = candles[0];
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));

  return (
    <>
      <div className="chart-tf">
        <Seg
          value={tf.key}
          onChange={setPicked}
          options={TIMEFRAMES.map((t) => [t.key, t.label] as const)}
          label="Candle timeframe"
        />
        <span className="dim">
          {candles.length} bars · {tf.label}
        </span>
      </div>

      <LightweightCandles
        candles={candles}
        ariaLabel={`${tf.label} candles for ${symbol}. Open ${tick(first.open)}, high ${tick(hi)}, low ${tick(lo)}, last ${tick(last.close)} gwei per ${symbol}.`}
      />

      <p className="field-note">
        Open, high, low, close per {tf.label} period, off every trade at both
        venues. Green is up, red is down; the band beneath is volume. Scroll to
        zoom, drag to pan.
        {truncated > 0 &&
          ` Showing the newest ${candles.length} periods of ${candles.length + truncated}.`}
        {pending > 0 &&
          ` ${pending} just-landed trade${pending === 1 ? "" : "s"} still being timed.`}
        {!feed.complete &&
          ` Off this token's newest ${feed.trades.length.toLocaleString()} trades — ${
            feed.trades.length >= ROWS
              ? "the feed's cap"
              : "as far back as the scan has reached so far"
          }.`}
      </p>
    </>
  );
}

/**
 * The candlestick plate, rendered with lightweight-charts.
 *
 * Replaces the hand-drawn SVG candles with TradingView's canvas chart, for the
 * zoom, pan and crosshair a trader expects — the candles were the view that most
 * wanted real interaction. The price line and the curve beside it stay hand-drawn
 * SVG; only this view moved to the library.
 *
 * Client-only by construction: `createChart` touches the DOM, so it runs in an
 * effect against a ref, never in render. Colours come from the same CSS variables
 * the rest of the chart uses, so the candles keep the app's palette on both light
 * and dark grounds, and `autoSize` tracks the container so the canvas is
 * responsive without a ResizeObserver of our own. The candle values are in the
 * same gwei-per-token unit `buildCandles` produces — quote-per-token for a paired
 * curve — so the axis reads the same as the rest of the panel.
 */
function LightweightCandles({
  candles,
  ariaLabel,
}: {
  candles: Candle[];
  ariaLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);

  // Create the chart once. Data arrives in the effect below, so a feed refresh
  // updates the series in place rather than tearing the canvas down.
  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const css = getComputedStyle(el);
    const v = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;
    const up = v("--goldleaf", "#c9a227");
    const down = v("--sell", "#e5484d");
    const faint = v("--ink-faint", "rgba(127,127,127,0.14)");
    const text = css.color || "#8a8f98";

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: faint },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
    });

    candleSeries.current = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    });
    volumeSeries.current = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      color: faint,
    });
    // The volume band sits in the bottom fifth, under the price.
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    return () => {
      chart.remove();
      candleSeries.current = null;
      volumeSeries.current = null;
    };
  }, []);

  useEffect(() => {
    const cs = candleSeries.current;
    const vs = volumeSeries.current;
    if (!cs || !vs) return;

    const bars: CandlestickData[] = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const vols: HistogramData[] = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      value: Number(c.volume) / 1e18,
      color: c.close >= c.open ? "rgba(201,162,39,0.35)" : "rgba(229,72,77,0.35)",
    }));
    cs.setData(bars);
    vs.setData(vols);
  }, [candles]);

  return (
    <div
      ref={box}
      className="chart"
      style={{ width: "100%", height: CANDLE_CANVAS_H }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}

/// ─── Shared furniture ───────────────────────────────────────────────────────

type Tick = { at: number; label: string };

/** Hairline grid, axis and ticks — the plate every chart is drawn on. */
function Frame({
  yTicks,
  xTicks,
  yUnit,
  xUnit,
}: {
  yTicks: Tick[];
  xTicks: Tick[];
  yUnit: string;
  xUnit: string;
}) {
  return (
    <>
      {yTicks.map((t) => (
        <g key={`y${t.at}`}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={t.at}
            y2={t.at}
            style={{ stroke: "var(--hair-2)", strokeWidth: 1 }}
          />
          <text
            x={PAD.l - 8}
            y={t.at + 3}
            textAnchor="end"
            className="chart-t"
          >
            {t.label}
          </text>
        </g>
      ))}

      {xTicks.map((t) => (
        <text
          key={`x${t.at}`}
          x={Math.min(W - PAD.r, Math.max(PAD.l, t.at))}
          y={H - 8}
          textAnchor={
            t.at <= PAD.l + 2 ? "start" : t.at >= W - PAD.r - 2 ? "end" : "middle"
          }
          className="chart-t"
        >
          {t.label}
        </text>
      ))}

      {/* The two axes, drawn last so they sit over the grid. */}
      <line
        x1={PAD.l}
        x2={PAD.l}
        y1={PAD.t}
        y2={PAD.t + PLOT.h}
        style={{ stroke: "var(--hair)", strokeWidth: 1 }}
      />
      <line
        x1={PAD.l}
        x2={W - PAD.r}
        y1={PAD.t + PLOT.h}
        y2={PAD.t + PLOT.h}
        style={{ stroke: "var(--hair)", strokeWidth: 1 }}
      />

      {/* Units name the axes once, up here, so the tick labels can stay bare
          numbers and the columns keep their alignment. */}
      <text x={PAD.l} y={PAD.t - 5} className="chart-t">
        {yUnit}
      </text>
      <text x={W - PAD.r} y={PAD.t - 5} textAnchor="end" className="chart-t">
        {xUnit}
      </text>
    </>
  );
}

/** Axis numbers: enough figures to be distinct, never more. */
function tick(g: number): string {
  if (g === 0) return "0";
  if (g >= 100) return g.toFixed(0);
  if (g >= 10) return g.toFixed(1);
  if (g >= 1) return g.toFixed(2);
  return g.toFixed(3);
}
