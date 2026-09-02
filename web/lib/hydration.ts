"use client";

import { useEffect, useState } from "react";
import { useChainId } from "wagmi";
import { CHAINS } from "./chains";

/**
 * The active chain id, pinned to the server's default until the client mounts.
 *
 * wagmi runs `ssr: true` with localStorage: the server always renders the
 * default chain, while the client can restore a different persisted chain.
 * Any value that turns the chain id into *markup* during the first client render
 * then risks a hydration mismatch — most sharply the per-chain "is this deployed
 * here" gate, which flips a whole page between its real UI and `NotDeployed`.
 *
 * On most routes render timing hides it: the first client paint still happens
 * before wagmi's restore, so it too sees the default, and `ChainSync` only
 * switches in a post-mount effect. But a `<Suspense>` boundary on the route —
 * `/swap` has one, because it reads `useSearchParams` — shifts that first render
 * past the restore and the mismatch surfaces. Returning the default until mounted
 * keeps the first client paint identical to the server HTML regardless of
 * Suspense; the real chain takes over one tick later, exactly as `ChainSync`
 * already drives it.
 *
 * `CHAINS[0]`, read rather than named. wagmi's default is the first chain in the
 * registry and that position has moved twice; a hook whose whole job is to agree
 * with the server cannot hold its own copy of which chain that is.
 *
 * Every chain-derived hook that resolves a contract address reads through this,
 * so "what is deployed here" is stable across hydration app-wide, not per route.
 */
export function useHydratedChainId() {
  const chainId = useChainId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? chainId : CHAINS[0].id;
}
