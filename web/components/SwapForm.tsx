"use client";

import type { ReactNode } from "react";
import type { Address } from "viem";
import { PercentPicks, SlippageControl } from "@/components/SlippageField";
import { TokenArt } from "@/components/TokenArt";
import { CURVE } from "@/lib/contracts";
import { fmtEth, fmtPriceGwei, fmtTokens } from "@/lib/format";
import { useCurveTrade, usePoolTrade, type Side } from "@/lib/trade-engine";

/**
 * The swap page's trade surface: a DEX-style From → To pair rather than the token
 * page's compact Buy/Sell tabs.
 *
 * On this launchpad ETH is the only universal counter-asset — a curve can only be
 * traded against it, and a graduated token's pool is a token/WETH pair — so one
 * leg is always ETH and the flip button reverses the direction: ETH → token is a
 * buy, token → ETH a sell. The presentation lives in {@link SwapForm}; the two
 * containers below wrap the shared {@link useCurveTrade} / {@link usePoolTrade}
 * engine (the launchpad for a live curve, our router for a graduated pool) and
 * hand the form a uniform shape.
 *
 * The token page keeps its own {@link TradePanel} / {@link PoolPanel} modal — the
 * two presentations are deliberately different, so they don't share JSX, only the
 * shared slippage/sizing controls and the trade engine.
 */

type Submit = {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger: boolean;
};

/**
 * ETH or the token, as a pill with its mark. The token side reuses TokenArt.
 *
 * The token pill is a button when the page hands down an `onSelect` — the swap
 * page opens its picker from here, which is where anyone who has used a DEX
 * expects to change the traded asset. The ETH side is never a button: on this
 * launchpad ETH is the fixed counter-asset, and the flip button below already
 * moves it between the two legs.
 */
function AssetChip({
  kind,
  token,
  symbol,
  uri,
  onSelect,
}: {
  kind: "eth" | "token";
  token: Address;
  symbol: string;
  uri: string;
  onSelect?: () => void;
}) {
  if (kind === "eth") {
    return (
      <span className="swap-asset">
        <span className="swap-eth-badge" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 16 16">
            <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" />
          </svg>
        </span>
        ETH
      </span>
    );
  }
  const mark = <TokenArt token={token} symbol={symbol} uri={uri} size={22} />;
  if (!onSelect) {
    return (
      <span className="swap-asset">
        {mark}
        {symbol}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="swap-asset"
      onClick={onSelect}
      aria-label={`Change token — currently ${symbol}`}
    >
      {mark}
      {symbol}
      <svg
        className="swap-asset-caret"
        width="9"
        height="9"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 6.5 8 10.5 12 6.5" />
      </svg>
    </button>
  );
}

/** Two opposed arrows — the direction toggle straddling the two legs. */
function FlipIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3.5V12" />
      <path d="M2.5 9.5 5 12 7.5 9.5" />
      <path d="M11 12.5V4" />
      <path d="M13.5 6.5 11 4 8.5 6.5" />
    </svg>
  );
}

/**
 * The shared, presentation-only swap layout. Every value it shows is computed by
 * a container — it holds no chain state of its own — so the curve and the pool
 * render identically and can never drift apart.
 */
function SwapForm({
  side,
  token,
  symbol,
  uri,
  raw,
  onRawChange,
  onFlip,
  onSelectToken,
  amount,
  pctBasis,
  onPick,
  noteLabel,
  noteValue,
  slippage,
  onSlippage,
  estOut,
  minOut,
  feeLabel,
  feeValue,
  notice,
  errorText,
  isConnected,
  submit,
  invalid,
  overBalance,
  overBalanceText,
}: {
  side: Side;
  token: Address;
  symbol: string;
  uri: string;
  raw: string;
  onRawChange: (s: string) => void;
  onFlip: () => void;
  onSelectToken?: () => void;
  amount: bigint | null;
  pctBasis: bigint;
  onPick: (wei: bigint) => void;
  noteLabel: string;
  noteValue: string;
  slippage: number;
  onSlippage: (bps: number) => void;
  estOut: bigint | undefined;
  minOut: bigint | undefined;
  feeLabel: string;
  feeValue: string;
  notice: ReactNode;
  errorText: string | undefined;
  isConnected: boolean;
  submit: Submit;
  invalid: boolean;
  overBalance: boolean;
  overBalanceText: string;
}) {
  // Buy pays ETH for the token; sell pays the token for ETH.
  const fromKind = side === "buy" ? "eth" : "token";
  const toKind = side === "buy" ? "token" : "eth";

  const fmtOut = (v: bigint) =>
    side === "buy" ? `${fmtTokens(v)}` : fmtEth(v, 6);

  // The effective rate for this size, in the same gwei-per-token unit as the
  // hero price above — it moves with fee and depth as the amount grows.
  const ethLeg = side === "buy" ? amount : estOut ?? null;
  const tokenLeg = side === "buy" ? estOut ?? null : amount;
  const rateE18 =
    ethLeg && tokenLeg && tokenLeg > 0n
      ? (ethLeg * 10n ** 18n) / tokenLeg
      : null;

  return (
    <div className="panel">
      <div className="swap-legs">
        <div className="swap-leg">
          <div className="swap-leg-head">
            <label htmlFor="swap-amt" style={{ margin: 0 }}>
              From
            </label>
            <SlippageControl value={slippage} onChange={onSlippage} />
          </div>
          <div className="swap-leg-body">
            <input
              id="swap-amt"
              className="swap-amt"
              type="text"
              inputMode="decimal"
              value={raw}
              placeholder="0.0"
              onChange={(e) => onRawChange(e.target.value)}
            />
            <AssetChip
              kind={fromKind}
              token={token}
              symbol={symbol}
              uri={uri}
              onSelect={onSelectToken}
            />
          </div>
          <PercentPicks
            basis={pctBasis}
            amount={amount}
            disabled={!isConnected || pctBasis <= 0n}
            onPick={onPick}
            noteLabel={noteLabel}
            noteValue={noteValue}
          />
        </div>

        <div className="swap-flip-row">
          <button
            type="button"
            className="swap-flip"
            aria-label="Flip swap direction"
            onClick={onFlip}
          >
            <FlipIcon />
          </button>
        </div>

        <div className="swap-leg">
          <div className="swap-leg-head">
            <span className="swap-leg-role">
              To <span className="dim">· estimated</span>
            </span>
          </div>
          <div className="swap-leg-body">
            <div className="swap-amt swap-amt-out">
              {estOut !== undefined ? fmtOut(estOut) : "0.0"}
            </div>
            <AssetChip
              kind={toKind}
              token={token}
              symbol={symbol}
              uri={uri}
              onSelect={onSelectToken}
            />
          </div>
          {rateE18 !== null && (
            <div className="field-note swap-rate">
              1 {symbol} ≈ {fmtPriceGwei(rateE18)} gwei
            </div>
          )}
        </div>
      </div>

      {invalid && (
        <div className="alert" style={{ marginTop: 12 }}>
          Not a valid amount.
        </div>
      )}
      {overBalance && (
        <div className="alert" style={{ marginTop: 12 }}>
          {overBalanceText}
        </div>
      )}

      {estOut !== undefined && (
        <dl style={{ margin: "16px 0" }}>
          <div className="r-row">
            <dt>Minimum received</dt>
            <dd>
              {minOut !== undefined
                ? side === "buy"
                  ? `${fmtTokens(minOut)} ${symbol}`
                  : `${fmtEth(minOut, 6)} ETH`
                : "—"}
            </dd>
          </div>
          <div className="r-row">
            <dt>{feeLabel}</dt>
            <dd>{feeValue}</dd>
          </div>
        </dl>
      )}

      {notice}

      {errorText && (
        <div className="alert" style={{ marginBottom: 14 }}>
          {errorText}
        </div>
      )}

      <button
        className={submit.danger ? "sell primary" : "primary"}
        disabled={submit.disabled}
        onClick={submit.onClick}
        style={{ width: "100%" }}
      >
        {submit.label}
      </button>

      {!isConnected && (
        <div
          className="field-note"
          style={{ textAlign: "center", marginTop: 10 }}
        >
          Connect a wallet to trade
        </div>
      )}
    </div>
  );
}

/**
 * From → To against a live bonding curve. A thin render over {@link useCurveTrade}
 * — the same engine the token page's {@link TradePanel} drives — in the swap-page
 * layout instead of the tabbed modal.
 */
export function CurveSwap({
  token,
  symbol,
  uri,
  balance,
  allowance,
  onDone,
  onSelectToken,
}: {
  token: Address;
  symbol: string;
  uri: string;
  balance: bigint;
  allowance: bigint;
  onDone: () => void;
  onSelectToken?: () => void;
}) {
  const t = useCurveTrade({ token, balance, allowance, onDone });

  const submit: Submit = t.needsApproval
    ? {
        label: t.busy ? "Approving…" : `Approve ${symbol}`,
        onClick: t.approve,
        disabled: !t.isConnected || t.busy,
        danger: false,
      }
    : {
        label: t.isPending
          ? "Confirm in wallet…"
          : t.mining
            ? "Settling…"
            : t.side === "buy"
              ? "Buy"
              : "Sell",
        onClick: t.trade,
        disabled: !t.canTrade,
        danger: t.side === "sell",
      };

  const notice =
    t.quote && t.quote.refund > 0n ? (
      <div className="alert ok" style={{ marginBottom: 14 }}>
        This buy graduates the token. It has been trimmed to land exactly on{" "}
        {fmtEth(CURVE.graduationEth)} ETH and the remainder is refunded to you in
        the same transaction.
      </div>
    ) : null;

  return (
    <SwapForm
      side={t.side}
      token={token}
      symbol={symbol}
      uri={uri}
      raw={t.raw}
      onRawChange={t.setRaw}
      onFlip={t.flip}
      onSelectToken={onSelectToken}
      amount={t.amount}
      pctBasis={t.pctBasis}
      onPick={t.setRawExact}
      noteLabel={t.side === "buy" ? "Balance" : "Holding"}
      noteValue={
        t.side === "buy"
          ? `${fmtEth(t.ethBalance, 4)} ETH`
          : `${fmtTokens(balance)} ${symbol}`
      }
      slippage={t.slippage}
      onSlippage={t.setSlippage}
      estOut={t.estOut}
      minOut={t.minOut}
      feeLabel="Trade fee"
      feeValue={t.quote ? `${fmtEth(t.quote.fee, 6)} ETH` : "—"}
      notice={notice}
      errorText={t.error}
      isConnected={t.isConnected}
      submit={submit}
      invalid={t.invalid}
      overBalance={t.overBalance}
      overBalanceText={
        t.side === "buy"
          ? `More than you hold — you have ${fmtEth(t.ethBalance, 4)} ETH.`
          : `More than you hold — you have ${fmtTokens(balance)} ${symbol}.`
      }
    />
  );
}

/**
 * From → To against a graduated pool. A thin render over {@link usePoolTrade} —
 * the same engine the token page's {@link PoolPanel} drives — in the swap-page
 * layout.
 */
export function PoolSwap({
  token,
  symbol,
  uri,
  onSelectToken,
}: {
  token: Address;
  symbol: string;
  uri: string;
  onSelectToken?: () => void;
}) {
  const t = usePoolTrade({ token });

  const submit: Submit = t.needsApproval
    ? {
        label: t.busy ? "Approving…" : `Approve ${symbol}`,
        onClick: t.approve,
        disabled: !t.isConnected || t.busy,
        danger: false,
      }
    : {
        label: t.isPending
          ? "Confirm in wallet…"
          : t.mining
            ? "Swapping…"
            : t.side === "buy"
              ? "Buy"
              : "Sell",
        onClick: t.swap,
        disabled: !t.canSwap,
        danger: t.side === "sell",
      };

  // Only reached for a graduated token, so the pair should exist — but the reads
  // resolving the router and pair are still in flight on first paint.
  if (!t.pair) {
    return t.resolving ? (
      <div className="empty" style={{ padding: "24px 0" }}>
        Sounding…
      </div>
    ) : (
      <p className="note" style={{ fontSize: 12.5 }}>
        No pool found for this token on the configured router.
      </p>
    );
  }

  return (
    <SwapForm
      side={t.side}
      token={token}
      symbol={symbol}
      uri={uri}
      raw={t.raw}
      onRawChange={t.setRaw}
      onFlip={t.flip}
      onSelectToken={onSelectToken}
      amount={t.amount}
      pctBasis={t.pctBasis}
      onPick={t.setRawExact}
      noteLabel={t.side === "buy" ? "Balance" : "Holding"}
      noteValue={
        t.side === "buy"
          ? `${fmtEth(t.ethBalance, 4)} ETH`
          : `${fmtTokens(t.balance)} ${symbol}`
      }
      slippage={t.slippage}
      onSlippage={t.setSlippage}
      estOut={t.estOut}
      minOut={t.minOut}
      feeLabel="Pool fee"
      feeValue="0.30% to liquidity"
      notice={null}
      errorText={t.error}
      isConnected={t.isConnected}
      submit={submit}
      invalid={t.invalid}
      overBalance={t.overBalance}
      overBalanceText={
        t.side === "buy"
          ? `More than you hold — you have ${fmtEth(t.ethBalance, 4)} ETH.`
          : `More than you hold — you have ${fmtTokens(t.balance)} ${symbol}.`
      }
    />
  );
}
