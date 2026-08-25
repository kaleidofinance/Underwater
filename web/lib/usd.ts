"use client";

import { useQuery } from "@tanstack/react-query";
import { formatUnits } from "viem";

/**
 * USD is a *display* layer over the ETH-native numbers, nothing more.
 *
 * Everything the protocol computes stays in wei — the curve, the quotes, the
 * market cap — because that is the only price no oracle can be wrong about. A
 * dollar figure needs a rate from *outside* the chain, so it is fetched once,
 * cached, and multiplied in here for the reader's benefit. If the rate is
 * unavailable the caller falls back to the native unit (gwei / ETH) rather than
 * showing a broken "$—": the ETH truth is always there.
 *
 * The rate comes from our own /api/eth-usd route (server-side, cached) so the
 * whole app shares one upstream call, not one per component.
 */

/** Live ETH/USD, or null while it loads or if the feed is down. */
export function useEthUsd(): number | null {
  const { data } = useQuery({
    queryKey: ["eth-usd"],
    queryFn: async () => {
      const res = await fetch("/api/eth-usd");
      if (!res.ok) throw new Error("rate unavailable");
      const json = (await res.json()) as { usd?: number };
      if (typeof json.usd !== "number" || !Number.isFinite(json.usd)) {
        throw new Error("bad rate");
      }
      return json.usd;
    },
    // The route caches upstream for 60s; the client can hold longer and refresh
    // in the background. A price this soft does not need to be to-the-second.
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
  });
  return typeof data === "number" ? data : null;
}

/** A wei amount (18-decimal ETH quantity — a balance, a cap, or a per-token
 *  price) as a USD float. `priceE18` is a wei-per-token value on the same
 *  18-decimal scale, so it converts with this too. */
export function usdFromWei(wei: bigint, ethUsd: number): number {
  return Number(formatUnits(wei, 18)) * ethUsd;
}

function trim(n: number, dp: number): string {
  return n.toFixed(dp).replace(/\.?0+$/, "");
}

/** Compact USD for caps, volumes, and balances: "$1.2M", "$45K", "$980",
 *  "$3.40". Sub-dollar amounts defer to the small-price formatter. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1e9) return `$${trim(n / 1e9, 2)}B`;
  if (n >= 1e6) return `$${trim(n / 1e6, 2)}M`;
  if (n >= 1e3) return `$${trim(n / 1e3, 1)}K`;
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return fmtUsdPrice(n);
}

/**
 * A per-token USD price, which at meme-token scale is a long string of leading
 * zeros — "$0.0000032". Uses the subscript-zero notation the rest of DeFi does
 * ("$0.0₅32" = five zeros then 32), so a price stays legible in the width a
 * table cell has. Larger prices fall back to plain decimals.
 */
export function fmtUsdPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1000) return fmtUsd(n);
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  // Below $1: count the zeros between the decimal point and the first digit.
  const frac = n.toFixed(20).slice(2);
  const lead = frac.length - frac.replace(/^0+/, "").length;
  const sig = frac.replace(/^0+/, "").replace(/0+$/, "").slice(0, 3) || "0";
  if (lead <= 3) return `$0.${"0".repeat(lead)}${sig}`;

  const sub = String(lead).replace(/[0-9]/g, (d) => "₀₁₂₃₄₅₆₇₈₉"[+d]);
  return `$0.0${sub}${sig}`;
}
