"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ZecCandles, type CandleBar } from "@/components/zec/ZecCandles";
import type { ZecCandle, ZecToken, ZecTrade } from "@/lib/zec/api";
import { fmtAgo, fmtTokenAmount, fmtZec, shortId, TOTAL_SUPPLY_TOKENS } from "@/lib/zec/format";

/** A token's mark: its image if it has an http(s) one, else its initials on a colour from its id. */
export function ZecAvatar({ token, size = 40 }: { token: Pick<ZecToken, "id" | "symbol" | "metadataURI">; size?: number }) {
  const hue = useMemo(() => [...token.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7), [token.id]);
  if (/^https?:\/\//.test(token.metadataURI)) {
    return <img className="zec-avatar" src={token.metadataURI} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="zec-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.36, background: `hsl(${hue} 55% 42%)` }}
    >
      {token.symbol.slice(0, 3).toUpperCase()}
    </span>
  );
}

export function ZecTokenCard({ token }: { token: ZecToken }) {
  const pct = Number(token.progressBps) / 100;
  return (
    <Link href={`/token/${token.id}`} className="card">
      <div className="card-head">
        <ZecAvatar token={token} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row-name">{token.name}</div>
          <div className="row-sub">
            {token.symbol} · {fmtAgo(token.createdAt)} ago
          </div>
        </div>
        {token.graduated && <span className="badge grad">graduated</span>}
      </div>
      <div className="card-foot">
        <div className="card-nums">
          <div className="num at-start">
            <small>Market cap</small>
            {fmtZec(token.marketCap, 2)} <span className="dim">ZEC</span>
          </div>
          <div className="num">
            <small>24h volume</small>
            {fmtZec(token.volume24h, 3)} <span className="dim">ZEC</span>
          </div>
        </div>
        <div>
          <div className="depth">
            <i style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="depth-cap">
            <span>{token.graduated ? "trading on the pool" : "bonding curve"}</span>
            <span className={pct >= 100 ? "gold" : ""}>{pct.toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

/**
 * Market-cap candles. The engine's price is ZEC per token, which for a young
 * meme coin is a fraction of a zatoshi; charting the market cap instead keeps
 * the axis readable (1.5 → 37.5 ZEC over the curve), and it's the number
 * traders watch anyway.
 */
export function ZecChart({ candles, symbol }: { candles: ZecCandle[]; symbol: string }) {
  const bars: CandleBar[] = useMemo(
    () =>
      candles.map((c) => ({
        time: c.time,
        open: c.open * TOTAL_SUPPLY_TOKENS,
        high: c.high * TOTAL_SUPPLY_TOKENS,
        low: c.low * TOTAL_SUPPLY_TOKENS,
        close: c.close * TOTAL_SUPPLY_TOKENS,
        volume: c.volume,
      })),
    [candles],
  );
  if (bars.length === 0) return <div className="empty">No trades yet — the chart starts with the first one.</div>;
  return (
    <div className="zec-chart">
      <ZecCandles candles={bars} ariaLabel={`${symbol} market cap in ZEC`} />
    </div>
  );
}

export function ZecTradeList({ trades, symbol }: { trades: ZecTrade[]; symbol: string }) {
  if (trades.length === 0) return <div className="empty">No trades yet.</div>;
  return (
    <div className="zec-trades">
      {trades.map((t) => (
        <div key={`${t.seq}-${t.side}-${t.tokens}`} className="r-row zec-trade">
          <span className={t.side === "buy" ? "ok" : "sell-text"}>{t.side}</span>
          <span className="num">{fmtZec(t.quote, 4)} ZEC</span>
          <span className="num dim">
            {fmtTokenAmount(t.tokens)} {symbol}
          </span>
          <span className="dim">{shortId(t.trader, 4)}</span>
          <span className="dim">{t.venue === "amm" ? "pool" : "curve"}</span>
          <span className="dim">{fmtAgo(t.ts)}</span>
        </div>
      ))}
    </div>
  );
}
