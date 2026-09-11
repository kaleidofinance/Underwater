"use client";

import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { pairLaunchpadAbi } from "./abis";
import { pairLaunchpadFor } from "./contracts";
import { useHydratedChainId } from "./hydration";

/**
 * A token a curve can be quoted in, other than ETH.
 *
 * The pair launchpad prices any 18-decimal ERC-20 whose economics an owner has
 * set (or, on mainnet later, a route pricer can value), but the contract holds
 * no enumerable list of them — economics are a mapping. So the *offer* the form
 * makes is a curated registry here: a chain's pairable assets, in the order the
 * dropdown lists them. ETH is not in this list; it is the classic launchpad and
 * the form's default.
 */
export type QuoteAsset = {
  address: Address;
  symbol: string;
  name: string;
};

/**
 * The pairable assets per chain.
 *
 * Robinhood testnet 46630 carries the three mock equities `DeployPairLaunchpad`
 * ships (see script/DeployPairLaunchpad.s.sol) — real Robinhood equities live
 * only on mainnet 4663, which has no pair launchpad yet. Hardcoded from the
 * deploy the way `deployedAt` blocks are: these are addresses a receipt fixes,
 * not values a visitor's env should carry. A chain with no entry offers ETH
 * only, which is the correct "no equities here yet" state.
 */
const QUOTE_ASSETS: Readonly<Record<number, readonly QuoteAsset[]>> = {
  46630: [
    { address: "0x97CC4C54F0DbF550A3df7123c0ffee4781F8c551", symbol: "mTSLA", name: "Mock Tesla" },
    { address: "0xf8947384f9acA8908fC0a7821991ceAFa27Bf770", symbol: "mNVDA", name: "Mock NVIDIA" },
    { address: "0x7ab5a48c23A30acc8B0B986B5470903DD52B3359", symbol: "mSPY", name: "Mock S&P 500" },
  ],
};

export function usePairLaunchpad() {
  const chainId = useHydratedChainId();
  const address = pairLaunchpadFor(chainId);
  return { address, chainId, configured: address !== null };
}

/**
 * The quote assets offered on the connected chain — empty unless a pair
 * launchpad is deployed there and the registry lists assets for it. The create
 * form shows the paired-asset dropdown only when this is non-empty.
 */
export function useQuoteAssets(): readonly QuoteAsset[] {
  const { chainId, configured } = usePairLaunchpad();
  if (!configured || chainId === undefined) return [];
  return QUOTE_ASSETS[chainId] ?? [];
}

/** Pair-launchpad config: the fees a paired launch pays. */
export function usePairLaunchpadConfig() {
  const { address, configured } = usePairLaunchpad();
  const common = { address: address ?? undefined, abi: pairLaunchpadAbi } as const;

  const { data } = useReadContracts({
    contracts: [
      { ...common, functionName: "creationFee" },
      { ...common, functionName: "tradeFeeBps" },
    ],
    query: { enabled: configured, refetchInterval: 12_000 },
  });

  return {
    creationFee: (data?.[0]?.result as bigint | undefined) ?? 0n,
    tradeFeeBps: (data?.[1]?.result as bigint | undefined) ?? 0n,
  };
}

/**
 * The graduation threshold and virtual reserve for a curve quoted in
 * `quoteToken`, both in that asset's own 18-decimal units.
 *
 * Read from the contract rather than the registry so it cannot drift from the
 * economics an owner has actually set. `virtualQuote` is `graduationQuote / 4` —
 * the curve's own identity, mirrored here so the form can preview the first buy
 * against the same reserves the contract will.
 */
export function usePairEconomics(quoteToken: Address | undefined) {
  const { address, configured } = usePairLaunchpad();

  const { data } = useReadContract({
    address: address ?? undefined,
    abi: pairLaunchpadAbi,
    functionName: "previewGraduationQuote",
    args: quoteToken ? [quoteToken] : undefined,
    query: { enabled: configured && !!quoteToken },
  });

  const graduationQuote = (data as bigint | undefined) ?? 0n;
  return { graduationQuote, virtualQuote: graduationQuote / 4n };
}
