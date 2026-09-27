/**
 * Token taxes on the web side: the shape the API speaks, the launch presets,
 * and one-line descriptions. The engine (zec/engine/tax.ts) is the authority;
 * this only has to agree with it on the limits.
 */

/** Wire form: basis points as decimal strings. */
export interface ZecTax {
  buyBps: string;
  sellBps: string;
  creatorBps: string;
  dividendsBps: string;
  buybackBps: string;
  liquidityBps: string;
}

/** Per-side ceiling, in percent. Must match MAX_TAX_BPS in zec/engine/tax.ts. */
export const MAX_TAX_PCT = 10;

export type Share = "creator" | "dividends" | "buyback" | "liquidity";
export const SHARES: { key: Share; label: string; help: string; color: string }[] = [
  { key: "creator", label: "Creator funds", help: "Paid straight into your balance.", color: "#b48cff" },
  { key: "dividends", label: "Dividends", help: "Shared by everyone holding the token, in proportion to what they hold.", color: "#f2c14e" },
  { key: "buyback", label: "Buyback and burn", help: "Buys the token from its pool and burns it. Waits for the pool until the token graduates.", color: "#e5484d" },
  { key: "liquidity", label: "Liquidity", help: "Added to the token's pool, deepening it. Waits for the pool until the token graduates.", color: "#3fb8af" },
];

/** Editor state, in percent (tax) and percent of the tax (split). */
export interface TaxDraft {
  buy: number;
  sell: number;
  split: Record<Share, number>;
}

export const NO_TAX: TaxDraft = { buy: 0, sell: 0, split: { creator: 100, dividends: 0, buyback: 0, liquidity: 0 } };

export const PRESETS: { key: string; label: string; blurb: string; draft: TaxDraft }[] = [
  { key: "creator", label: "Creator-backed", blurb: "1% to the creator", draft: { buy: 1, sell: 1, split: { creator: 100, dividends: 0, buyback: 0, liquidity: 0 } } },
  { key: "diamond", label: "Diamond hands", blurb: "3% to dividends", draft: { buy: 3, sell: 3, split: { creator: 0, dividends: 100, buyback: 0, liquidity: 0 } } },
  { key: "deflation", label: "Deflationary", blurb: "3% to buyback", draft: { buy: 3, sell: 3, split: { creator: 0, dividends: 0, buyback: 100, liquidity: 0 } } },
  { key: "autolp", label: "Auto-LP", blurb: "3% back into the pool", draft: { buy: 3, sell: 3, split: { creator: 0, dividends: 0, buyback: 0, liquidity: 100 } } },
];

export const splitTotal = (d: TaxDraft): number => SHARES.reduce((s, x) => s + d.split[x.key], 0);
export const isTaxed = (d: TaxDraft): boolean => d.buy > 0 || d.sell > 0;

/** Percent → basis points, rounded to a whole basis point. */
const bps = (pct: number) => String(Math.round(pct * 100));

/** The wire form of a draft, or undefined for no tax. */
export function toWire(d: TaxDraft): ZecTax | undefined {
  if (!isTaxed(d)) return undefined;
  return {
    buyBps: bps(d.buy),
    sellBps: bps(d.sell),
    creatorBps: bps(d.split.creator),
    dividendsBps: bps(d.split.dividends),
    buybackBps: bps(d.split.buyback),
    liquidityBps: bps(d.split.liquidity),
  };
}

const pct = (b: string) => `${Number(b) / 100}%`;

/** "3% buy · 3% sell → 50% creator · 50% holders" */
export function describeTax(t: ZecTax | null): string | null {
  if (!t) return null;
  const sides = t.buyBps === t.sellBps ? `${pct(t.buyBps)} each way` : `${pct(t.buyBps)} buy · ${pct(t.sellBps)} sell`;
  const words: Record<Share, string> = { creator: "creator", dividends: "holders", buyback: "buyback & burn", liquidity: "liquidity" };
  const parts = SHARES.filter((s) => t[`${s.key}Bps`] !== "0").map((s) => `${pct(t[`${s.key}Bps`])} ${words[s.key]}`);
  return `${sides} → ${parts.join(" · ")}`;
}
