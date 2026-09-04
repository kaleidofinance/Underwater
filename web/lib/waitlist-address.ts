import type { Address } from "viem";
import { networkFor } from "./chains";

/**
 * The waitlist contract, per chain — the address half of lib/waitlist.ts, split
 * out so a route handler can use it.
 *
 * lib/waitlist.ts is `"use client"`, and "use client" is transitive: importing it
 * from a route gets a client reference, not the function, so `/api/points` cannot
 * resolve the waitlist for its log scans. The lookup itself is one field of the
 * registry in lib/chains.ts and has no client-only dependency, so it lives here;
 * the hook file re-exports `waitlistFor`, which is why nothing that used to import
 * it there changed.
 *
 * Null on Robinhood *testnet* by construction, and set on Robinhood mainnet. The Ink
 * waitlists are intake for the plates allowlist, which only Ink can carry; the
 * Robinhood mainnet one collects registrations for the mainnet launch instead, so a
 * waitlist on a network does not imply the collection is there too — see the note on
 * `NETWORKS`.
 */
export function waitlistFor(chainId: number | undefined): Address | null {
  return networkFor(chainId)?.deployments.waitlist ?? null;
}
