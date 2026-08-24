"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
// `injected` deliberately comes from the wagmi root, not `wagmi/connectors`.
// That barrel pulls in the Base Account connector, which drags in
// @coinbase/cdp-sdk and its optional @x402/* peers — none of them installed, so
// the build fails to resolve them. wagmi re-exports the same connector here.
import { http, createConfig, injected, WagmiProvider } from "wagmi";
import { ChainSync } from "@/components/ChainSync";
import { anvil, ink, inkSepolia } from "@/lib/chains";

/// Injected-only for now. A launchpad wants WalletConnect and a Coinbase
/// connector too, but both need project IDs / extra config, and injected covers
/// every browser wallet on Ink today — so this stays honest rather than showing
/// buttons that fail.
const config = createConfig({
  chains: [ink, inkSepolia, anvil],
  connectors: [injected()],
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
