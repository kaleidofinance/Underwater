"use client";

import type { Address } from "viem";
import { PercentPicks, SlippageControl } from "@/components/SlippageField";
import { fmtEth, fmtTokens } from "@/lib/format";
import { usePairCurveTrade, usePairPoolTrade } from "@/lib/trade-engine";

/**
 * Buy and sell an equity-paired token, in the quote token's units.
 *
 * Two faces over two engines that share a shape: {@link PairTradePanel} trades the
 * live curve through the pair launchpad, {@link PairPoolPanel} trades the
 * token/quote pool a graduated one lives in through the router. Both are their own
 * components rather than a branched {@link TradePanel}, so the ETH panel and its
 * engine cannot move when these do — the same isolation the pair launchpad keeps
 * from the ETH launchpad on chain.
 *
 * A buy spends the quote token and a sell spends the launched token, so both sides
 * can want an approval — unlike the ETH curve, where only a sell does. No points
 * row: paired trades earn none today (see the engine).
 */

/** The fields the face reads — the common subset both pair engines return. */
type PairEngine = {
  side: "buy" | "sell";
  selectSide: (side: "buy" | "sell") => void;
  raw: string;
  setRaw: (v: string) => void;
  setRawExact: (wei: bigint) => void;
  slippage: number;
  setSlippage: (bps: number) => void;
  amount: bigint | null;
  invalid: boolean;
  overBalance: boolean;
  /** The buy-side spend balance — the quote token's. */
  ethBalance: bigint;
  /** The launched token's balance, for the sell side. */
  balance: bigint;
  pctBasis: bigint;
  quote: { out: bigint; fee: bigint; refund: bigint } | null;
  minOut: bigint | undefined;
  needsApproval: boolean;
  busy: boolean;
  canTrade: boolean;
  isConnected: boolean;
  ready: boolean;
  isPending: boolean;
  mining: boolean;
  error: string | undefined;
  approve: () => void;
  trade: () => void;
};

function PairTradeFace({
  t,
  symbol,
  quoteSymbol,
  graduationQuote,
}: {
  t: PairEngine;
  symbol: string;
  quoteSymbol: string;
  /** Only used by the curve face's graduation notice; 0 for a pool. */
  graduationQuote: bigint;
}) {
  const { quote } = t;
  const q = quoteSymbol || "quote";
  // What the current side spends, which is what the amount is measured in.
  const unit = t.side === "buy" ? q : symbol || "tokens";
  const spendNote =
    t.side === "buy"
      ? `${fmtEth(t.ethBalance, 4)} ${q}`
      : `${fmtTokens(t.balance)} ${symbol || "tokens"}`;

  return (
    <div className="panel">
      <div className="tabs">
        <button data-active={t.side === "buy"} onClick={() => t.selectSide("buy")}>
          Buy
        </button>
        <button data-active={t.side === "sell"} onClick={() => t.selectSide("sell")}>
          Sell
        </button>
      </div>

      <div className="field">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <label htmlFor="amt" style={{ marginBottom: 0 }}>
            Amount ({unit})
          </label>
          <SlippageControl value={t.slippage} onChange={t.setSlippage} />
        </div>
        <input
          id="amt"
          type="text"
          inputMode="decimal"
          value={t.raw}
          placeholder="0.0"
          onChange={(e) => t.setRaw(e.target.value)}
        />
        <PercentPicks
          basis={t.pctBasis}
          amount={t.amount}
          disabled={!t.isConnected || t.pctBasis <= 0n}
          onPick={t.setRawExact}
          noteLabel={t.side === "buy" ? "Balance" : "Holding"}
          noteValue={spendNote}
        />
      </div>

      {t.invalid && <div className="alert">Not a valid amount.</div>}
      {t.overBalance && (
        <div className="alert">More than you hold — you have {spendNote}.</div>
      )}

      {quote && t.amount !== null && (
        <dl style={{ marginBottom: 16 }}>
          <div className="r-row">
            <dt>You receive</dt>
            <dd className="gold">
              {t.side === "buy"
                ? `${fmtTokens(quote.out)} ${symbol}`
                : `${fmtEth(quote.out, 6)} ${q}`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Minimum after slippage</dt>
            <dd>
              {t.minOut === undefined
                ? "—"
                : t.side === "buy"
                  ? fmtTokens(t.minOut)
                  : `${fmtEth(t.minOut, 6)} ${q}`}
            </dd>
          </div>
          {/* Curve trades carry a launchpad fee; a pool swap pays the pool, so its
              fee is zero here and the row is dropped. */}
          {quote.fee > 0n && (
            <div className="r-row">
              <dt>Trade fee</dt>
              <dd>
                {fmtEth(quote.fee, 6)} {q}
              </dd>
            </div>
          )}
          {quote.refund > 0n && (
            <div className="r-row">
              <dt>Refunded</dt>
              <dd className="gold">
                {fmtEth(quote.refund, 6)} {q}
              </dd>
            </div>
          )}
        </dl>
      )}

      {quote && quote.refund > 0n && (
        <div className="alert ok" style={{ marginBottom: 14 }}>
          This buy graduates the token. It has been trimmed to land exactly on{" "}
          {fmtEth(graduationQuote)} {q} and the remainder is refunded to you in the
          same transaction.
        </div>
      )}

      {t.error && (
        <div className="alert" style={{ marginBottom: 14 }}>
          {t.error}
        </div>
      )}

      {t.needsApproval ? (
        <button
          className="primary"
          disabled={!t.ready || t.busy}
          onClick={t.approve}
          style={{ width: "100%" }}
        >
          {t.busy ? "Approving…" : `Approve ${unit}`}
        </button>
      ) : (
        <button
          className={t.side === "sell" ? "sell primary" : "primary"}
          disabled={!t.canTrade}
          onClick={t.trade}
          style={{ width: "100%" }}
        >
          {t.isPending
            ? "Confirm in wallet…"
            : t.mining
              ? "Settling…"
              : t.side === "buy"
                ? "Buy"
                : "Sell"}
        </button>
      )}

      {!t.ready && (
        <div className="field-note" style={{ textAlign: "center", marginTop: 10 }}>
          {t.isConnected ? "Reconnecting your wallet…" : "Connect a wallet to trade"}
        </div>
      )}
    </div>
  );
}

/** The live paired curve, through the pair launchpad. */
export function PairTradePanel({
  token,
  quoteToken,
  quoteSymbol,
  symbol,
  balance,
  graduationQuote,
  onDone,
}: {
  token: Address;
  quoteToken: Address;
  quoteSymbol: string;
  symbol: string;
  /** The launched token's balance, for the sell side and its "Holding" note. */
  balance: bigint;
  graduationQuote: bigint;
  onDone: () => void;
}) {
  const t = usePairCurveTrade({ token, quoteToken, balance, onDone });
  return (
    <PairTradeFace
      t={t}
      symbol={symbol}
      quoteSymbol={quoteSymbol}
      graduationQuote={graduationQuote}
    />
  );
}

/** The graduated token/quote pool, through the router. */
export function PairPoolPanel({
  token,
  quoteToken,
  quoteSymbol,
  symbol,
  onDone,
}: {
  token: Address;
  quoteToken: Address;
  quoteSymbol: string;
  symbol: string;
  onDone: () => void;
}) {
  const t = usePairPoolTrade({ token, quoteToken, onDone });

  // Resolved with no pool: a graduation that has not seeded liquidity yet, which
  // is a moment rather than a state, so it says so instead of a dead button.
  if (t.noPool) {
    return (
      <div className="panel">
        <div className="panel-head">
          <span>Pool</span>
        </div>
        <p className="note" style={{ fontSize: 12.5 }}>
          This token has graduated but its {quoteSymbol || "quote"} pool has not
          been seeded yet. Trading opens the moment it is.
        </p>
      </div>
    );
  }

  return (
    <PairTradeFace t={t} symbol={symbol} quoteSymbol={quoteSymbol} graduationQuote={0n} />
  );
}
