"use client";

import type { ReactNode } from "react";
import type { Address } from "viem";
import { PercentPicks, SlippageControl } from "@/components/SlippageField";
import { TokenArt } from "@/components/TokenArt";
import { CURVE } from "@/lib/contracts";
import { fmtEth, fmtPriceGwei, fmtTokens } from "@/lib/format";
import { useCurveTrade, usePoolTrade } from "@/lib/trade-engine";

/**
 * The swap page's trade surface: a DEX-style From → To pair rather than the token
 * page's compact Buy/Sell tabs.
 *
 * ETH is the counter-asset a token always has — a curve can only be traded against
 * it, and graduation seeds a token/WETH pair — but it is no longer the only one a
 * pool swap can use. Two graduated tokens can be swapped for each other by routing
 * through WETH, so each leg carries its own {@link SwapAsset} and the flip button
 * reverses which one is being acquired. The presentation lives in {@link SwapForm};
 * the two containers below wrap the shared {@link useCurveTrade} /
 * {@link usePoolTrade} engine (the launchpad for a live curve, our router for a
 * graduated pool) and hand the form a uniform shape.
 *
 * The token page keeps its own {@link TradePanel} / {@link PoolPanel} modal — the
 * two presentations are deliberately different, so they don't share JSX, only the
 * shared slippage/sizing controls and the trade engine.
 */

/**
 * What one leg is holding.
 *
 * ETH carries nothing because there is nothing to carry: the mark is a glyph and the
 * ticker is fixed. A token carries what `TokenArt` needs. A discriminated union
 * rather than one `token`/`symbol`/`uri` triple serving both legs, which is what this
 * was — and which could only ever describe a trade with ETH on one side of it.
 */
export type SwapAsset =
  | { kind: "eth" }
  | { kind: "token"; token: Address; symbol: string; uri: string };

export const ETH_ASSET: SwapAsset = { kind: "eth" };

const symbolOf = (a: SwapAsset) => (a.kind === "eth" ? "ETH" : a.symbol);

/** An amount in an asset's own unit, for the fill and the minimum. */
const fmtAsset = (a: SwapAsset, v: bigint) =>
  a.kind === "eth" ? fmtEth(v, 6) : fmtTokens(v);

/** An amount with its ticker, for a balance line — fewer places, it is a readout. */
const fmtHeld = (a: SwapAsset, v: bigint) =>
  a.kind === "eth" ? `${fmtEth(v, 4)} ETH` : `${fmtTokens(v)} ${a.symbol}`;

type Submit = {
  label: string;
  onClick: () => void;
  disabled: boolean;
  danger: boolean;
};

/** The chevron on anything that opens the token picker. */
function Caret() {
  return (
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
  );
}

/** ETH's mark: the same diamond the picker's ETH row uses. */
export function EthBadge({ size = 22 }: { size?: number }) {
  return (
    <span
      className="swap-eth-badge"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        width={Math.round(size * 0.45)}
        height={Math.round(size * 0.45)}
        viewBox="0 0 16 16"
      >
        <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" />
      </svg>
    </span>
  );
}

/**
 * One leg's asset, as a pill with its mark.
 *
 * A button when the page hands down an `onSelect` — which is where anyone who has
 * used a DEX expects to change the traded asset. That now includes the ETH pill on a
 * graduated token, because ETH is one choice among the pools rather than a fixture:
 * pressing it opens the picker that can put another token opposite. On a curve it
 * still gets no handler, because a curve has nothing else to trade against.
 */
function AssetChip({
  asset,
  onSelect,
}: {
  asset: SwapAsset;
  onSelect?: () => void;
}) {
  const label = symbolOf(asset);
  const mark =
    asset.kind === "eth" ? (
      <EthBadge />
    ) : (
      <TokenArt
        token={asset.token}
        symbol={asset.symbol}
        uri={asset.uri}
        size={22}
      />
    );
  if (!onSelect) {
    return (
      <span className="swap-asset">
        {mark}
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="swap-asset"
      onClick={onSelect}
      aria-label={`Change asset — currently ${label}`}
    >
      {mark}
      {label}
      <Caret />
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
 * The rate this size actually fills at — it moves with fee and depth as the amount
 * grows, and over two hops it moves with both pools.
 *
 * Quoted in gwei whenever one leg is ETH, which is the unit every price on the site
 * is in. Token for token there is no ETH leg to quote against, so it is the plain
 * ratio between the two — the same number, without pretending it is a price.
 */
function RateNote({
  from,
  to,
  amount,
  estOut,
}: {
  from: SwapAsset;
  to: SwapAsset;
  amount: bigint | null;
  estOut: bigint | undefined;
}) {
  if (amount === null || amount <= 0n || estOut === undefined || estOut <= 0n) {
    return null;
  }
  const WAD = 10n ** 18n;
  const text =
    to.kind === "eth"
      ? `1 ${symbolOf(from)} ≈ ${fmtPriceGwei((estOut * WAD) / amount)} gwei`
      : from.kind === "eth"
        ? `1 ${symbolOf(to)} ≈ ${fmtPriceGwei((amount * WAD) / estOut)} gwei`
        : `1 ${symbolOf(from)} ≈ ${fmtTokens((estOut * WAD) / amount)} ${symbolOf(to)}`;
  return <div className="field-note swap-rate">{text}</div>;
}

/**
 * The shared, presentation-only swap layout. Every value it shows is computed by
 * a container — it holds no chain state of its own — so the curve and the pool
 * render identically and can never drift apart.
 *
 * It is given the two legs rather than a side and a token: which asset sits where is
 * the container's business, since only it knows whether the counter is ETH. That also
 * means the two legs get separate select handlers, because changing what you pay with
 * and changing what you are buying are different actions.
 */
function SwapForm({
  from,
  to,
  raw,
  onRawChange,
  onFlip,
  onSelectFrom,
  onSelectTo,
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
  from: SwapAsset;
  to: SwapAsset;
  raw: string;
  onRawChange: (s: string) => void;
  onFlip: () => void;
  onSelectFrom?: () => void;
  onSelectTo?: () => void;
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
            <AssetChip asset={from} onSelect={onSelectFrom} />
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
              {estOut !== undefined ? fmtAsset(to, estOut) : "0.0"}
            </div>
            <AssetChip asset={to} onSelect={onSelectTo} />
          </div>
          <RateNote from={from} to={to} amount={amount} estOut={estOut} />
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
                ? `${fmtAsset(to, minOut)} ${symbolOf(to)}`
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
 * The same box with no token in it yet.
 *
 * A DEX is a swap box. Whoever arrives — no wallet, no launches of their own,
 * nothing held, a network whose launchpad has never been used — should land on the
 * thing the page is for and be one press from filling it in, not on a notice
 * explaining why there is nothing here. So the empty state is the box: real legs,
 * real ETH pill, everything inert, and every part of it that can be pressed opens
 * the token picker.
 *
 * It is a separate component rather than {@link SwapForm} with optional props
 * because SwapForm's values all come from a trade engine bound to a token — there
 * is no amount to quote, no balance to take a percentage of and no route to price
 * until one is chosen. Threading "no token" through that would put a dozen
 * null checks in the live path to serve the state that trades nothing.
 */
export function SwapPlaceholder({
  loading,
  onSelectToken,
}: {
  loading: boolean;
  onSelectToken: () => void;
}) {
  return (
    <div className="panel">
      <div className="swap-legs">
        <div className="swap-leg">
          <div className="swap-leg-head">
            <span className="swap-leg-role">From</span>
          </div>
          <div className="swap-leg-body">
            <div className="swap-amt swap-amt-out">0.0</div>
            <AssetChip asset={ETH_ASSET} />
          </div>
        </div>

        <div className="swap-flip-row">
          <button
            type="button"
            className="swap-flip"
            aria-label="Flip swap direction"
            disabled
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
            <div className="swap-amt swap-amt-out">0.0</div>
            <button type="button" className="swap-asset" onClick={onSelectToken}>
              Select a token
              <Caret />
            </button>
          </div>
        </div>
      </div>

      <button
        className="primary"
        onClick={onSelectToken}
        style={{ width: "100%", marginTop: 14 }}
      >
        {loading ? "Sounding…" : "Select a token"}
      </button>
    </div>
  );
}

/**
 * From → To against a live bonding curve. A thin render over {@link useCurveTrade}
 * — the same engine the token page's {@link TradePanel} drives — in the swap-page
 * layout instead of the tabbed modal.
 *
 * ETH is the only thing a curve trades against, so that leg gets no select handler:
 * there is no second choice to offer, and the flip button already moves ETH between
 * the two legs. Only the graduated form ({@link PoolSwap}) can put a token opposite.
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

  const subject: SwapAsset = { kind: "token", token, symbol, uri };
  const from = t.side === "buy" ? ETH_ASSET : subject;
  const to = t.side === "buy" ? subject : ETH_ASSET;

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
      from={from}
      to={to}
      raw={t.raw}
      onRawChange={t.setRaw}
      onFlip={t.flip}
      onSelectFrom={from.kind === "token" ? onSelectToken : undefined}
      onSelectTo={to.kind === "token" ? onSelectToken : undefined}
      amount={t.amount}
      pctBasis={t.pctBasis}
      onPick={t.setRawExact}
      noteLabel={from.kind === "eth" ? "Balance" : "Holding"}
      noteValue={fmtHeld(
        from,
        from.kind === "eth" ? t.ethBalance : balance,
      )}
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
      overBalanceText={`More than you hold — you have ${fmtHeld(
        from,
        from.kind === "eth" ? t.ethBalance : balance,
      )}.`}
    />
  );
}

/**
 * From → To against a graduated pool. A thin render over {@link usePoolTrade} —
 * the same engine the token page's {@link PoolPanel} drives — in the swap-page
 * layout.
 *
 * `counter` is what sits opposite the subject. Absent means ETH, which is the only
 * thing this could trade against before; a token means the swap routes through WETH
 * and crosses two pools. Both legs are selectable in that case, and they are separate
 * handlers because they write to different pieces of the page's state.
 */
export function PoolSwap({
  token,
  symbol,
  uri,
  counter,
  onSelectToken,
  onSelectCounter,
}: {
  token: Address;
  symbol: string;
  uri: string;
  counter?: { token: Address; symbol: string; uri: string };
  onSelectToken?: () => void;
  onSelectCounter?: () => void;
}) {
  const t = usePoolTrade({ token, counter: counter?.token });

  const subject: SwapAsset = { kind: "token", token, symbol, uri };
  // `t.counter` rather than the prop: the engine drops a counter equal to the
  // subject, and the legs have to describe the route it actually quoted.
  const other: SwapAsset =
    counter && t.counter ? { kind: "token", ...counter } : ETH_ASSET;
  const twoHop = other.kind === "token";

  const from = t.side === "buy" ? other : subject;
  const to = t.side === "buy" ? subject : other;

  // "Buy" and "Sell" only name the trade while ETH is the other side of it. Token for
  // token there is no quote currency to be long or short of, so it is a swap, and the
  // sell-red styling goes with the word.
  const verb = twoHop ? "Swap" : t.side === "buy" ? "Buy" : "Sell";

  const submit: Submit = t.needsApproval
    ? {
        label: t.busy ? "Approving…" : `Approve ${symbolOf(from)}`,
        onClick: t.approve,
        disabled: !t.isConnected || t.busy,
        danger: false,
      }
    : {
        label: t.isPending
          ? "Confirm in wallet…"
          : t.mining
            ? "Swapping…"
            : verb,
        onClick: t.swap,
        disabled: !t.canSwap,
        danger: !twoHop && t.side === "sell",
      };

  const notice = t.noRoute ? (
    <div className="alert" style={{ marginBottom: 14 }}>
      No route to {counter?.symbol || "that token"} — it is still on its bonding
      curve, so there is no pool for the second hop. Trade it against ETH until it
      graduates.
    </div>
  ) : twoHop ? (
    <div className="alert ok" style={{ marginBottom: 14 }}>
      Routed {symbolOf(from)} → WETH → {symbolOf(to)}. Every pool on this DEX is
      paired against WETH, so a token-for-token swap crosses two of them: it pays
      0.30% to each, and your tolerance covers both at once.
    </div>
  ) : null;

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
      from={from}
      to={to}
      raw={t.raw}
      onRawChange={t.setRaw}
      onFlip={t.flip}
      onSelectFrom={t.side === "buy" ? onSelectCounter : onSelectToken}
      onSelectTo={t.side === "buy" ? onSelectToken : onSelectCounter}
      amount={t.amount}
      pctBasis={t.pctBasis}
      onPick={t.setRawExact}
      noteLabel={from.kind === "eth" ? "Balance" : "Holding"}
      noteValue={fmtHeld(from, t.inBalance)}
      slippage={t.slippage}
      onSlippage={t.setSlippage}
      estOut={t.estOut}
      minOut={t.minOut}
      feeLabel="Pool fee"
      feeValue={twoHop ? "0.60% — 0.30% per pool" : "0.30% to liquidity"}
      notice={notice}
      errorText={t.error}
      isConnected={t.isConnected}
      submit={submit}
      invalid={t.invalid}
      overBalance={t.overBalance}
      overBalanceText={`More than you hold — you have ${fmtHeld(from, t.inBalance)}.`}
    />
  );
}
