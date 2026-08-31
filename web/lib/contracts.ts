import type { Address } from "viem";
import { networkFor } from "./chains";

/// The deployed launchpad on a chain, or null where there is not one.
///
/// The address itself comes from the registry in lib/chains.ts, which holds one
/// record per network — see the note on `NETWORKS` for why every table keyed by
/// chain id collapsed into that one. The UI reads this and shows an honest "not
/// deployed here" state rather than firing calls at the zero address; see
/// `NotDeployed` in `components/Chrome.tsx`.
export function launchpadFor(chainId: number | undefined): Address | null {
  return networkFor(chainId)?.deployments.launchpad ?? null;
}

/// Curve constants. These are `constant` in the contract, so hard-coding them
/// here costs no correctness and saves a round trip on every render. The
/// launchpad test suite asserts the identities that tie them together.
export const CURVE = {
  totalSupply: 1_000_000_000n * 10n ** 18n,
  curveSupply: 800_000_000n * 10n ** 18n,
  lpSupply: 200_000_000n * 10n ** 18n,
  virtualEth: 10n ** 18n,
  graduationEth: 4n * 10n ** 18n,
} as const;

export const LP_BURN_ADDRESS =
  "0x000000000000000000000000000000000000dEaD" as const;

/**
 * The plates collection's `constant`s.
 *
 * Hard-coded for the same reason `CURVE` is: they cannot change, so reading them
 * would cost a round trip per render and buy nothing. Everything the owner *can*
 * move — both prices, both limits, the allowlist root — is read from the chain on
 * every poll instead, in `usePlatesState`. Getting that split wrong is how a mint
 * page ends up quoting a price the contract will reject.
 *
 * Here rather than in lib/plates.ts, which is where it reads like it belongs,
 * because that module is `"use client"`: a server import of one of its exports
 * gets a client reference, not the value, so `PLATES.supply` came back
 * `undefined` and the share card's `toLocaleString` threw during prerender —
 * failing the production build rather than the page. lib/plates.ts re-exports it,
 * so client code is unaffected either way. Anything a server component or a
 * route handler needs has to be reachable without crossing that boundary.
 */
export const PLATES = {
  supply: 2222n,
  wlAllocation: 2000n,
  priceCeiling: 10n ** 18n,
  limitCeiling: 222n,
  royaltyBps: 500n,
  categories: 10n,
  maxScars: 8n,
  /// 1e18-scaled. At or below `drownHf` anyone may burn a plate; below `scarHf` a
  /// survivor can be engraved.
  drownHf: 10n ** 18n,
  scarHf: 14n * 10n ** 17n,
} as const;
