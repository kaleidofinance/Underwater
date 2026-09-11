"use client";

import type { Address } from "viem";
import { PercentPicks, SlippageControl } from "@/components/SlippageField";
import { fmtEth, fmtTokens } from "@/lib/format";
import { usePairCurveTrade } from "@/lib/trade-engine";

/**
 * Buy and sell against a live equity-paired bonding curve.
 *
 * The sibling of {@link TradePanel} for a curve quoted in an ERC-20. It is its
 * own component, not a branched TradePanel, so the ETH panel and its engine
 * cannot move when this does — the same isolation the pair launchpad keeps from
 * the ETH launchpad on chain. The state machine is {@link usePairCurveTrade};
 * what's here is the face, in the quote token's units.
 *
 * A buy spends the quote token and a sell spends the launched token, so both
 * sides can want an approval — unlike the ETH curve, where only a sell does. No
 * points row: paired trades earn none today (see the engine).
 */
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
  const { quote } = t;
  const q = quoteSymbol || "quote";
  // What the current side spends, which is what the amount is measured in.
  const unit = t.side === "buy" ? q : symbol || "tokens";
  const spendNote =
    t.side === "buy"
      ? `${fmtEth(t.ethBalance, 4)} ${q}`
      : `${fmtTokens(balance)} ${symbol || "tokens"}`;

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
          <div className="r-row">
            <dt>Trade fee</dt>
            <dd>
              {fmtEth(quote.fee, 6)} {q}
            </dd>
          </div>
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
