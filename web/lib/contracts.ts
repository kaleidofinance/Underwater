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

function normalise(value: string | undefined): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  if (/^0x0{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

export function launchpadFor(chainId: number | undefined): Address | null {
  if (chainId === undefined) return null;
  return normalise(ENV[chainId]);
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
