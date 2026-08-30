"use client";

import { useState } from "react";

/** The tolerances offered on both venues. */
export const SLIPPAGE_OPTIONS = [50, 100, 300, 1000] as const;

/**
 * Default tolerance, in bps.
 *
 * 3% is loose for a pool swap and tight for a curve buy near graduation, which is
 * the honest compromise for a single default — the point of the picker is that
 * nobody is stuck with it.
 */
export const DEFAULT_SLIPPAGE_BPS = 300;

/** 0.001 ETH held back so a Max *buy* still has gas to broadcast — ample on Ink,
 *  where gas is a rounding error, and irrelevant to a sell (tokens pay no gas). */
const GAS_RESERVE = 10n ** 15n;

/**
 * What the percentage picks spend from: the balance of whatever the trade pays
 * with, less a gas cushion when that is ETH itself. One rule, so the curve panel,
 * the pool panel and the swap console can never disagree about what "50%" means.
 *
 * Keyed on the asset rather than on buy/sell, which stopped being the same question
 * once a pool swap could pay with a token in either direction: a buy routed through
 * a token counter spends an ERC20, and holding a thousandth back out of an ERC20
 * balance would quietly make "Max" not the maximum.
 */
export function spendableBasis(paysWithEth: boolean, balance: bigint): bigint {
  if (!paysWithEth) return balance;
  return balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n;
}

/** The two-slider "adjust settings" glyph on the slippage toggle. */
function GearIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="2.5" y1="5" x2="13.5" y2="5" />
      <line x1="2.5" y1="11" x2="13.5" y2="11" />
      <circle cx="6" cy="5" r="2" fill="var(--paper)" />
      <circle cx="10" cy="11" r="2" fill="var(--paper)" />
    </svg>
  );
}

/**
 * Slippage tolerance as a compact toggle: it shows the live value (e.g. "3%") and
 * opens a popover of {@link SLIPPAGE_OPTIONS}. It sits on the amount label row of
 * both trade panels, keeping the applied tolerance in view of whoever signs while
 * ceding the primary space to the amount itself.
 *
 * It lives here, shared, because the pool panel used to hardcode 3% while the
 * curve panel let you choose: the same decision, made two ways, and only one of
 * them visible. One control means a tolerance can never be applied that was not
 * shown.
 */
export function SlippageControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (bps: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Slippage tolerance"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "4px 8px",
          fontSize: 9,
          letterSpacing: "0.1em",
          borderColor: open ? "var(--goldleaf)" : undefined,
          color: open ? "var(--goldleaf)" : "var(--ink-dim)",
        }}
      >
        <GearIcon />
        {value / 100}%
      </button>
      {open && (
        <>
          {/* A full-viewport backdrop so a click anywhere else dismisses it. */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              zIndex: 41,
              width: 232,
              padding: 12,
              background: "var(--paper)",
              border: "1px solid var(--hair)",
              boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 8.5,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--ink-dim)",
                marginBottom: 8,
              }}
            >
              Slippage tolerance
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => {
                    onChange(bps);
                    setOpen(false);
                  }}
                  data-active={value === bps}
                  style={{
                    flex: 1,
                    padding: "6px 0",
                    fontSize: 9,
                    borderColor: value === bps ? "var(--goldleaf)" : undefined,
                    color: value === bps ? "var(--goldleaf)" : undefined,
                  }}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const PCTS = [
  { p: 25, label: "25%" },
  { p: 50, label: "50%" },
  { p: 75, label: "75%" },
  { p: 100, label: "Max" },
] as const;

/**
 * The 25 / 50 / 75 / Max sizing row plus the balance readout beneath it. Each
 * button writes a fraction of `basis` back into the amount field (Max being the
 * whole basis to the wei), so a trade can be sized without arithmetic and still
 * edited by hand afterward. The active pick stays highlighted while the amount
 * still equals it.
 */
export function PercentPicks({
  basis,
  amount,
  disabled,
  onPick,
  noteLabel,
  noteValue,
}: {
  basis: bigint;
  amount: bigint | null;
  disabled: boolean;
  onPick: (wei: bigint) => void;
  noteLabel: string;
  noteValue: string;
}) {
  const partOf = (p: number) => (p >= 100 ? basis : (basis * BigInt(p)) / 100n);
  const active =
    amount !== null && amount > 0n && basis > 0n
      ? [25, 50, 75, 100].find((p) => partOf(p) === amount) ?? null
      : null;
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        {PCTS.map(({ p, label }) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            onClick={() => onPick(partOf(p))}
            data-active={active === p}
            style={{
              flex: 1,
              padding: "6px 0",
              fontSize: 9,
              borderColor: active === p ? "var(--goldleaf)" : undefined,
              color: active === p ? "var(--goldleaf)" : undefined,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="field-note"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{noteLabel}</span>
        <span>{noteValue}</span>
      </div>
    </>
  );
}
