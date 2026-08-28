import type { Address } from "viem";
import { anvil, ink, inkSepolia } from "./chains";

/// Deployed launchpad per chain, from the environment.
///
/// Nothing is deployed to a real Ink network yet, so these are blank by design.
/// The UI reads `launchpadFor()` and shows an honest "not deployed here" state
/// rather than firing calls at the zero address — see `NotDeployed` in
/// `components/Chrome.tsx`.
const ENV: Record<number, string | undefined> = {
  [ink.id]: process.env.NEXT_PUBLIC_LAUNCHPAD_INK,
  [inkSepolia.id]: process.env.NEXT_PUBLIC_LAUNCHPAD_INK_SEPOLIA,
  [anvil.id]: process.env.NEXT_PUBLIC_LAUNCHPAD_ANVIL,
};

/// A deployment address out of the environment, or null.
///
/// Exported because the plates collection is configured the same way and has the
/// same failure modes — a blank variable, a placeholder left as the zero address,
/// a value with a stray newline from a shell heredoc. One guard, used twice.
export function envAddress(value: string | undefined): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  if (/^0x0{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

export function launchpadFor(chainId: number | undefined): Address | null {
  if (chainId === undefined) return null;
  return envAddress(ENV[chainId]);
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
