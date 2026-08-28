"use client";

import type { Address } from "viem";
import { PercentPicks, SlippageControl } from "@/components/SlippageField";
import { fmtEth, fmtTokens, shortAddr } from "@/lib/format";
import { usePoolTrade } from "@/lib/trade-engine";

/**
 * Post-graduation trading, straight through our own router.
 *
 * A graduated token no longer has a curve — the launchpad's `buy`/`sell` revert
 * with `AlreadyGraduated`. This panel is the successor. Router/pair resolution,
 * quoting with the router's own `getAmountsOut`, and the swap all live in the
 * shared {@link usePoolTrade} engine — which resolves everything from the
 * launchpad's own `router()`, so it can never point at a different DEX than the
 * one holding the liquidity — and this file is just the token page's face of it.
 */
export function PoolPanel({ token, symbol }: { token: Address; symbol: string }) {
  const t = usePoolTrade({ token });
  const { amountOut } = t;

  if (!t.pair) {
    return (
      <div className="panel">
        <div className="panel-head">
          <span>Pool</span>
        </div>
        {t.resolving ? (
          <div className="empty" style={{ padding: "24px 0" }}>
            Sounding…
          </div>
        ) : (
          <p className="note" style={{ fontSize: 12.5 }}>
            No pool found for this token on the configured router.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Pool — liquidity burned</span>
        <span className="dim">{shortAddr(t.pair)}</span>
      </div>

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
          <label htmlFor="pamt" style={{ marginBottom: 0 }}>
            Amount ({t.side === "buy" ? "ETH" : symbol})
          </label>
          <SlippageControl value={t.slippage} onChange={t.setSlippage} />
        </div>
        <input
          id="pamt"
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
              : `${fmtTokens(t.balance)} ${symbol}`
          }
        />
      </div>


      {t.invalid && <div className="alert">Not a valid amount.</div>}
      {/* Names the figure, in the unit the amount above is in. "More than you
          hold." was true either way and so said nothing: the reader still has to
          go and look at what they hold to know what to type instead. */}
      {t.overBalance && (
        <div className="alert">
          More than you hold — you have{" "}
          {t.side === "buy"
            ? `${fmtEth(t.ethBalance, 4)} ETH`
            : `${fmtTokens(t.balance)} ${symbol}`}
          .
        </div>
      )}

      {/* No reserves row here: the token's own readout panel states the pool's
          liquidity, and printing the same two numbers twice on one page is noise. */}
      {amountOut !== undefined && (
        <dl style={{ marginBottom: 16 }}>
          <div className="r-row">
            <dt>You receive</dt>
            <dd className="gold">
              {t.side === "buy"
                ? `${fmtTokens(amountOut)} ${symbol}`
                : `${fmtEth(amountOut, 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Minimum after slippage</dt>
            <dd>
              {t.minOut === undefined
                ? "—"
                : t.side === "buy"
                  ? `${fmtTokens(t.minOut)} ${symbol}`
                  : `${fmtEth(t.minOut, 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Pool fee</dt>
            <dd>0.30% to liquidity</dd>
          </div>
        </dl>
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
          disabled={!t.canSwap}
          onClick={t.swap}
          style={{ width: "100%" }}
        >
          {t.isPending
            ? "Confirm in wallet…"
            : t.mining
              ? "Swapping…"
              : t.side === "buy"
                ? "Buy"
                : "Sell"}
        </button>
      )}
    </div>
  );
}
