import type { Address } from "viem";
import { anvil, ink, inkSepolia, robinhood, robinhoodTestnet } from "./chains";
import { envAddress } from "./contracts";

/**
 * The waitlist contract, per chain — the address half of lib/waitlist.ts, split
 * out so a route handler can use it.
 *
 * lib/waitlist.ts is `"use client"`, and "use client" is transitive: importing it
 * from a route gets a client reference, not the function, so `/api/points` cannot
 * resolve the waitlist for its log scans. The address table itself is plain env
 * and has no client-only dependency, so it lives here; the hook file re-exports
 * `waitlistFor`, which is why nothing that used to import it there changed.
 */
const ENV: Record<number, string | undefined> = {
  [ink.id]: process.env.NEXT_PUBLIC_WAITLIST_INK,
  [inkSepolia.id]: process.env.NEXT_PUBLIC_WAITLIST_INK_SEPOLIA,
  [robinhood.id]: process.env.NEXT_PUBLIC_WAITLIST_ROBINHOOD,
  [robinhoodTestnet.id]: process.env.NEXT_PUBLIC_WAITLIST_ROBINHOOD_TESTNET,
  [anvil.id]: process.env.NEXT_PUBLIC_WAITLIST_ANVIL,
};

export function waitlistFor(chainId: number | undefined): Address | null {
  if (chainId === undefined) return null;
  return envAddress(ENV[chainId]);
}
