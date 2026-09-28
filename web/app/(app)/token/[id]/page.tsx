"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Seg } from "@/components/Seg";
import { ZecAvatar, ZecChart, ZecTradeList } from "@/components/zec/ZecBits";
import { ZecTradePanel } from "@/components/zec/ZecTradePanel";
import { fmtAgo, fmtTokenAmount, fmtZec, shortId } from "@/lib/zec/format";
import { describeTax } from "@/lib/zec/tax";
import { useZecCandles, useZecKey, useZecMe, useZecToken, useZecTrades } from "@/lib/zec/hooks";

const FRAMES: readonly (readonly [string, string])[] = [
  ["60", "1m"],
  ["300", "5m"],
  ["900", "15m"],
  ["3600", "1h"],
];

export default function ZecTokenPage() {
  const { id } = useParams<{ id: string }>();
  const [frame, setFrame] = useState("60");
  const token = useZecToken(id);
  const trades = useZecTrades(id);
  const candles = useZecCandles(id, Number(frame));
  const key = useZecKey();
  const me = useZecMe(key);

  if (token.error) return <div className="empty">That token doesn't exist.</div>;
  const t = token.data;
  if (!t) return <div className="empty">Sounding…</div>;

  const pct = Number(t.progressBps) / 100;
  const raised = BigInt(t.curve.realQuoteRaised);
  const target = BigInt(t.curve.graduationQuote);

  return (
    <>
      <div className="zec-token-head">
        <ZecAvatar token={t} size={56} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 className="zec-token-name">
            {t.name} <span className="dim">{t.symbol}</span>
          </h1>
          <div className="row-sub">
            by {shortId(t.creator, 4)} · {fmtAgo(t.createdAt)} ago · {t.graduated ? "trading on the pool" : "on the bonding curve"}
          </div>
          {t.tax && <div className="row-sub zec-tax-line">tax {describeTax(t.tax)}</div>}
          {t.tax && BigInt(t.taxTotals.collected) > 0n && (
            <div className="row-sub">
              {[
                BigInt(t.creatorEarned) > 0n && `${fmtZec(t.creatorEarned, 4)} ZEC to the creator`,
                BigInt(t.taxTotals.dividends) > 0n && `${fmtZec(t.taxTotals.dividends, 4)} ZEC to holders`,
                BigInt(t.taxTotals.burned) > 0n && `${fmtTokenAmount(t.taxTotals.burned)} ${t.symbol} burned`,
                BigInt(t.taxTotals.liquidity) > 0n && `${fmtZec(t.taxTotals.liquidity, 4)} ZEC to the pool`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>
        <div className="num">
          <small>Market cap</small>
          {fmtZec(t.marketCap, 2)} <span className="dim">ZEC</span>
        </div>
      </div>

      <div className="depth">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="depth-cap">
        <span>
          {t.graduated
            ? "graduated: liquidity is locked in the pool for good"
            : `${fmtZec(raised, 3)} / ${fmtZec(target, 0)} ZEC raised; graduates at ${fmtZec(target, 0)}`}
        </span>
        <span className={pct >= 100 ? "gold" : ""}>{pct.toFixed(1)}%</span>
      </div>

      <div className="zec-grid">
        <div className="panel">
          <div className="panel-head">
            <span>Market cap (ZEC)</span>
            <Seg value={frame} onChange={setFrame} label="Timeframe" options={FRAMES} />
          </div>
          <ZecChart candles={candles.data ?? []} symbol={t.symbol} />
        </div>
        <ZecTradePanel token={t} me={me.data} />
      </div>

      <div className="panel">
        <div className="panel-head">Trades</div>
        <ZecTradeList trades={trades.data ?? []} symbol={t.symbol} />
      </div>
    </>
  );
}
