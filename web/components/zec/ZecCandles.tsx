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
import { useEffect, useRef } from "react";

export interface CandleBar {
  /** Bucket start, unix seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** ZEC traded in the bucket. */
  volume: number;
}

const HEIGHT = 268;

/**
 * Candles with a volume band underneath, drawn by lightweight-charts.
 *
 * Client-only by construction: `createChart` touches the DOM, so it runs in an
 * effect against a ref, never in render. Colours come from the app's CSS
 * variables, so the candles keep the palette on light and dark grounds, and
 * `autoSize` tracks the container.
 */
export function ZecCandles({ candles, ariaLabel }: { candles: CandleBar[]; ariaLabel: string }) {
  const box = useRef<HTMLDivElement>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);

  // Create the chart once. Data arrives in the effect below, so a refresh
  // updates the series in place rather than tearing the canvas down.
  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const css = getComputedStyle(el);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const up = v("--goldleaf", "#c9a227");
    const down = v("--sell", "#e5484d");
    const faint = v("--ink-faint", "rgba(127,127,127,0.14)");

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: css.color || "#8a8f98",
        fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: faint } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
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
      value: c.volume,
      color: c.close >= c.open ? "rgba(201,162,39,0.35)" : "rgba(229,72,77,0.35)",
    }));
    cs.setData(bars);
    vs.setData(vols);
  }, [candles]);

  return <div ref={box} className="chart" style={{ width: "100%", height: HEIGHT }} role="img" aria-label={ariaLabel} />;
}
