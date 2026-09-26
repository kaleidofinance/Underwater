"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/** One query cache per browser session. The live stream (useZecLive) invalidates it as trades land. */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
