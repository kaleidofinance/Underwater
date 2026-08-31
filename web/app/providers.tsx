"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
// `injected` deliberately comes from the wagmi root, not `wagmi/connectors`.
// The rest have to come from the barrel, which has no subpath exports — and it
// re-exports the Base Account connector, which reaches @coinbase/cdp-sdk and its
// optional @x402/* peers. Those aren't installed, so the production webpack build
// fails resolving them (Turbopack dev resolves lazily, so it doesn't); we never
// use Base Account, so next.config.ts stubs @x402/* to empty modules. Keeping the
// root import for `injected` is the same connector either way.
import { http, createConfig, fallback, injected, WagmiProvider } from "wagmi";
import { coinbaseWallet, walletConnect } from "wagmi/connectors";
import { ChainSync } from "@/components/ChainSync";
import { CHAINS } from "@/lib/chains";
import { HeadSync } from "@/lib/refresh";
// Imported above `createConfig` for a reason that is not style: this module reads
// the persisted connection at evaluation time, and `createConfig` overwrites it.
// See lib/wallet-persist.ts.
import { WalletPersist } from "@/lib/wallet-persist";

/// WalletConnect is the only way onto this from a phone that is not running a
/// wallet's own browser, and it is the one connector that cannot be configured
/// from here: it needs a project ID from cloud.reown.com, and without one it
/// throws the moment it is clicked. So it is registered only when the env var is
/// set — an option that cannot work is not offered rather than offered broken.
///
/// Coinbase Wallet needs nothing, so it is always here. Both the Coinbase SDK and
/// the WalletConnect provider are dynamically imported by their connectors, so
/// neither is in the bundle a visitor downloads until they pick it.
const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

/**
 * One HTTP request per tick, and a second endpoint to send it to.
 *
 * `batch: true` collects every JSON-RPC call viem makes in the same tick into a
 * single POST, and it is the other half of the `multicall3` entry in
 * lib/chains.ts: multicall folds the `eth_call`s of *one* `useReadContracts` into
 * one call, and this folds what is left over — `eth_getBalance`,
 * `eth_blockNumber`, `eth_getTransactionCount`, and the multicalls belonging to
 * every other hook mounted on the page — into one request.
 *
 * Both halves are needed because Ink's public gel RPC rate-limits per IP hard
 * enough that the unbatched version took the gate down; that note is on
 * MULTICALL3. `fallback` is the belt to that braces: viem ranks the endpoints and
 * moves to the next on error, so one endpoint having a bad day costs a retry
 * instead of every number on the page. The list comes off the chain definition
 * rather than being written out again here, so the preference order lives in one
 * place — see the RPC note in lib/chains.ts.
 *
 * The retry policy is viem's default on purpose — three tries with a backoff,
 * which is worth more now than it was: one dropped request used to cost one read
 * and now costs the whole batch.
 */
const rpc = (chain: (typeof CHAINS)[number]) =>
  fallback(chain.rpcUrls.default.http.map((url) => http(url, { batch: true })));

const config = createConfig({
  chains: CHAINS,
  connectors: [
    injected(),
    // `all` lets the extension answer if it is installed and falls back to the
    // popup and the phone app if it is not — smartWalletOnly would refuse an
    // extension the visitor already has.
    coinbaseWallet({ appName: "underwater.fun", preference: "all" }),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId })] : []),
  ],
  // Built from the chain list rather than written out per network, so a network in
  // the registry cannot end up switchable with no transport behind it — wagmi's
  // types demand one entry per chain, but only if the list is a literal, and it
  // stopped being one when it became the registry's own.
  transports: Object.fromEntries(CHAINS.map((chain) => [chain.id, rpc(chain)])),
  ssr: true,
  // Ink is a ~1s L2 and Robinhood Chain is a ~0.1s one, and viem's default 4s poll
  // is what HeadSync rides on, so the default would cap "live" at four seconds
  // behind the chain. `cacheTime: 0` is the load-bearing half: viem caches
  // `getBlockNumber` for `cacheTime` (which defaults to `pollingInterval`), and the
  // log scanners call it to pick their `toBlock` — a cached head meant a scan run
  // right after a trade could ask for blocks that ended before the trade landed,
  // and then cache that empty answer.
  pollingInterval: 2_000,
  cacheTime: 0,
});

export function Providers({ children }: { children: ReactNode }) {
  // One client per mount, never shared across requests on the server.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 4_000,
            retry: 1,
            // On, because a trade *leaves* this tab: the wallet popup or the
            // WalletConnect hand-off to a phone hides the document, and React
            // Query pauses every `refetchInterval` while it is hidden. Without a
            // refetch on the way back, the page you return to is the page you
            // left — pre-trade — until each query's timer next happens to fire.
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {/* The chain is remembered by wagmi's own storage, which nobody can see
            or send to anyone. ChainSync puts it in the address bar too, so a
            link to a token names the chain the token is on. It must sit inside
            both providers — it switches chains through a query mutation — and
            renders nothing. */}
        <ChainSync />
        {/* Puts back the connection `createConfig` overwrote a moment ago, so a
            refresh does not read as a disconnect. After ChainSync, deliberately:
            the whole account of why is in lib/wallet-persist.ts. Renders nothing
            either. */}
        <WalletPersist />
        {/* Follows the chain head and invalidates the contract reads, so every
            balance and price on any page tracks the chain rather than its own
            timer. Also renders nothing. See lib/refresh.ts. */}
        <HeadSync />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
