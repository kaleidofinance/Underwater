"use client";

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

/**
 * The slippage picker, shared by the curve panel and the pool panel.
 *
 * It lives here because the pool panel used to hardcode 3% while the curve panel
 * let you choose: the same decision, made two different ways, and only one of
 * them visible to the person signing. One control means a tolerance can never be
 * applied that was not shown.
 */
export function SlippageField({
  value,
  onChange,
}: {
  value: number;
  onChange: (bps: number) => void;
}) {
  return (
    <div className="field">
      <label>Slippage tolerance</label>
      <div style={{ display: "flex", gap: 8 }}>
        {SLIPPAGE_OPTIONS.map((bps) => (
          <button
            key={bps}
            type="button"
            onClick={() => onChange(bps)}
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
  );
}
