"use client";

import { MAX_TAX_PCT, NO_TAX, PRESETS, SHARES, isTaxed, splitTotal, type Share, type TaxDraft } from "@/lib/zec/tax";

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));

/**
 * The launch screen's "Advanced" tax section: a preset or a custom split, a
 * buy and a sell rate, and where the proceeds go. Each share's slider stops
 * where the others leave off, so the split can never pass 100%; it has to
 * reach exactly 100% to launch with a tax.
 */
export function ZecTaxEditor({ value, onChange }: { value: TaxDraft; onChange: (d: TaxDraft) => void }) {
  const preset = PRESETS.find(
    (p) => p.draft.buy === value.buy && p.draft.sell === value.sell && SHARES.every((s) => p.draft.split[s.key] === value.split[s.key]),
  );
  const custom = isTaxed(value) && !preset;
  const total = splitTotal(value);

  const setShare = (key: Share, raw: number) => {
    const others = total - value.split[key];
    onChange({ ...value, split: { ...value.split, [key]: clamp(Math.round(raw), 0, 100 - others) } });
  };
  const setRate = (side: "buy" | "sell", raw: number) => onChange({ ...value, [side]: round1(clamp(raw, 0, MAX_TAX_PCT)) });

  return (
    <details className="zec-tax" open={isTaxed(value)}>
      <summary>
        <span>Advanced: token tax</span>
        <span className="dim">{isTaxed(value) ? `${value.buy}% buy · ${value.sell}% sell` : "none"}</span>
      </summary>

      <div className="zec-tax-head">
        <span className="k">Where the tax goes</span>
        <button type="button" className="link" onClick={() => onChange(NO_TAX)}>
          Reset
        </button>
      </div>
      <div className="zec-tax-presets">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" data-active={preset?.key === p.key} onClick={() => onChange(p.draft)}>
            <b>{p.label}</b>
            <span>{p.blurb}</span>
          </button>
        ))}
        <button
          type="button"
          data-active={custom}
          onClick={() => onChange(isTaxed(value) ? value : { ...value, buy: 3, sell: 3 })}
        >
          <b>Custom</b>
          <span>your own split</span>
        </button>
      </div>

      <div className="zec-tax-rates">
        {(["buy", "sell"] as const).map((side) => (
          <label key={side} className="zec-tax-slider">
            <span>{side === "buy" ? "Buy tax" : "Sell tax"}</span>
            <div>
              <input
                type="range"
                min={0}
                max={MAX_TAX_PCT}
                step={0.1}
                value={value[side]}
                onChange={(e) => setRate(side, Number(e.target.value))}
              />
              <span className="zec-tax-num">
                <input inputMode="decimal" value={value[side]} onChange={(e) => setRate(side, Number(e.target.value))} aria-label={`${side} tax percent`} />%
              </span>
            </div>
          </label>
        ))}
      </div>

      <div className="zec-tax-split">
        <div className="zec-tax-shares">
          <p className="field-note">Each share stops where the others leave off. They must total 100% to launch.</p>
          {SHARES.map((s) => {
            const max = 100 - (total - value.split[s.key]);
            return (
              <label key={s.key} className="zec-tax-slider" title={s.help}>
                <span>
                  {s.label} <span className="dim">max {max}%</span>
                </span>
                <div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={value.split[s.key]}
                    style={{ accentColor: s.color }}
                    onChange={(e) => setShare(s.key, Number(e.target.value))}
                  />
                  <span className="zec-tax-num">
                    <input inputMode="numeric" value={value.split[s.key]} onChange={(e) => setShare(s.key, Number(e.target.value))} aria-label={`${s.label} percent`} />%
                  </span>
                </div>
                <small className="dim">{s.help}</small>
              </label>
            );
          })}
        </div>
        <Donut split={value.split} total={total} />
      </div>
    </details>
  );
}

/** The split as a ring: one arc per share, and the running total in the middle. */
function Donut({ split, total }: { split: Record<Share, number>; total: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  let at = 0;
  return (
    <svg className="zec-tax-donut" viewBox="0 0 140 140" role="img" aria-label={`Split totals ${total}%`}>
      <circle cx="70" cy="70" r={r} fill="none" stroke="var(--hair)" strokeWidth="16" />
      {SHARES.filter((s) => split[s.key] > 0).map((s) => {
        const len = (split[s.key] / 100) * c;
        const arc = (
          <circle
            key={s.key}
            cx="70"
            cy="70"
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth="16"
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-at}
            transform="rotate(-90 70 70)"
          />
        );
        at += len;
        return arc;
      })}
      <text x="70" y="68" textAnchor="middle" className="zec-tax-donut-v">
        {total}%
      </text>
      <text x="70" y="86" textAnchor="middle" className="zec-tax-donut-k">
        {total === 100 ? "Total split" : "must be 100%"}
      </text>
    </svg>
  );
}
