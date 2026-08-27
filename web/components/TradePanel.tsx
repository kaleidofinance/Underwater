"use client";

import type { Address } from "viem";
import { PercentPicks, SlippageControl } from "@/components/SlippageField";
import { fmtEth, fmtTokens } from "@/lib/format";
import type { Pool } from "@/lib/hooks";
import { useCurveTrade } from "@/lib/trade-engine";

/**
 * Buy and sell against the bonding curve.
 *
 * The trade itself — quoting off the contract's own `quoteBuy` / `quoteSell`, the
 * graduating-buy size-down and gas headroom, the sell approval, the write — lives
 * in the shared {@link useCurveTrade} engine, so this panel and the swap page's
 * From → To console can never price the same fill differently. What's here is only
 * this face: compact Buy/Sell tabs and a receipt.
 */
export function TradePanel({
  token,
  symbol,
  pool,
  balance,
  allowance,
  onDone,
}: {
  token: Address;
  symbol: string;
  pool: Pool;
  balance: bigint;
  allowance: bigint;
  onDone: () => void;
}) {
  const t = useCurveTrade({ token, balance, allowance, onDone });
  const { quote } = t;
  const unit = t.side === "buy" ? "ETH" : symbol || "tokens";

  return (
    <div className="panel">
      <div className="tabs">
        <button data-active={t.side === "buy"} onClick={() => t.setSide("buy")}>
          Buy
        </button>
        <button
          data-active={t.side === "sell"}
          onClick={() => t.setSide("sell")}
        >
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
          noteValue={
            t.side === "buy"
              ? `${fmtEth(t.ethBalance, 4)} ETH`
              : `${fmtTokens(balance)} ${symbol || "tokens"}`
          }
        />
      </div>


      {t.invalid && <div className="alert">Not a valid amount.</div>}
      {/* Same unit as the Amount label above, which flips with the tab. Before the
          guard covered buys this only ever fired on a sell, so naming the token
          balance was always right; now it fires on both and has to follow. */}
      {t.overBalance && (
        <div className="alert">
          More than you hold — you have{" "}
          {t.side === "buy"
            ? `${fmtEth(t.ethBalance, 4)} ETH`
            : `${fmtTokens(balance)} ${symbol || "tokens"}`}
          .
        </div>
      )}

      {quote && t.amount !== null && (
        <dl style={{ marginBottom: 16 }}>
          <div className="r-row">
            <dt>You receive</dt>
            <dd className="gold">
              {t.side === "buy"
                ? `${fmtTokens(quote.out)} ${symbol}`
                : `${fmtEth(quote.out, 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Minimum after slippage</dt>
            <dd>
              {t.minOut === undefined
                ? "—"
                : t.side === "buy"
                  ? fmtTokens(t.minOut)
                  : `${fmtEth(t.minOut, 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Trade fee</dt>
            <dd>{fmtEth(quote.fee, 6)} ETH</dd>
          </div>
          {quote.refund > 0n && (
            <div className="r-row">
              <dt>Refunded</dt>
              <dd className="gold">{fmtEth(quote.refund, 6)} ETH</dd>
            </div>
          )}
        </dl>
      )}

      {/* The size-down is the one behaviour worth calling out before signing:
          the buy that crosses 4 ETH is trimmed to land exactly on it. */}
      {quote && quote.refund > 0n && (
        <div className="alert ok" style={{ marginBottom: 14 }}>
          This buy graduates the token. It has been trimmed to land exactly on 4
          ETH and the remainder is refunded to you in the same transaction.
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
          disabled={!t.isConnected || t.busy}
          onClick={t.approve}
          style={{ width: "100%" }}
        >
          {t.busy ? "Approving…" : `Approve ${symbol}`}
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

      {!t.isConnected && (
        <div
          className="field-note"
          style={{ textAlign: "center", marginTop: 10 }}
        >
          Connect a wallet to trade
        </div>
      )}

      {pool.graduated && (
        <div className="alert info" style={{ marginTop: 14 }}>
          This curve has closed. Trading happens on the pool now.
        </div>
      )}
    </div>
  );
}
