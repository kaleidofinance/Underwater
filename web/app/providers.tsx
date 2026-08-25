"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
// `injected` deliberately comes from the wagmi root, not `wagmi/connectors`.
// The rest have to come from the barrel, which has no subpath exports — it once
// failed to resolve because the Base Account connector it re-exports reaches for
// @coinbase/cdp-sdk. That package is installed now and nothing in it imports its
// optional @x402/* peers, so the barrel resolves; keep the root import for
// `injected` anyway, since it is the same connector either way.
import { http, createConfig, injected, WagmiProvider } from "wagmi";
import { coinbaseWallet, walletConnect } from "wagmi/connectors";
import { ChainSync } from "@/components/ChainSync";
import { anvil, ink, inkSepolia } from "@/lib/chains";

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

const config = createConfig({
  chains: [ink, inkSepolia, anvil],
  connectors: [
    injected(),
    // `all` lets the extension answer if it is installed and falls back to the
    // popup and the phone app if it is not — smartWalletOnly would refuse an
    // extension the visitor already has.
    coinbaseWallet({ appName: "underwater.fun", preference: "all" }),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId })] : []),
  ],
  transports: {
    [ink.id]: http(),
    [inkSepolia.id]: http(),
    [anvil.id]: http(),
  },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  // One client per mount, never shared across requests on the server.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 4_000, retry: 1, refetchOnWindowFocus: false },
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
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
