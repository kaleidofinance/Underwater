"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useChainId } from "wagmi";
import { big, getJson } from "./wire";

/**
 * Telling the cache the chain moved.
 *
 * Chain state is pushed; wagmi's reads are pulled. Every read in this app used to
 * refresh on nothing but its own `refetchInterval` — 8s for a token's balances,
 * 12s for the market list, 15s for the trade feed, 20s for market volume — and a
 * confirmed trade only ever called back the one or two queries its own form knew
 * about. So a trade you had just watched settle would leave your ETH balance
 * untouched (`useBalance` carries no interval at all, so it never refreshed for
 * the life of the mount), your position stale for eight seconds, and the feed and
 * the volume stale for twenty. React Query's timers are also paused whenever the
 * document is hidden, which is exactly what a wallet popup or a WalletConnect
 * hand-off to a phone does — so the intervals were not merely slow, they were
 * stopped for the part of the flow that mattered.
 *
 * Two different jobs, because the two kinds of read cost very different money:
 *
 * - {@link HeadSync} follows the chain head and invalidates the cheap reads —
 *   `eth_call` multicalls and balances — once per block. This is what makes the
 *   whole app feel live, including the masthead balance, which no trade form can
 *   reach. The head itself now comes from `/api/head` rather than from the
 *   visitor's own RPC: it is one number, identical for everyone on a chain, and
 *   asking for it per tab was the most duplicated request in the app.
 * - {@link useChainRefresh} additionally invalidates the `eth_getLogs` scans (the
 *   feed, market volume, the candles). Those are far dearer than a multicall and
 *   must not run every block, so they refresh on their own timer and on the one
 *   event that is guaranteed to have changed them: a transaction of ours landing.
 *
 * Invalidation, not `refetch()`: it reaches every mounted copy of a query no
 * matter which component owns it, and React Query leaves unmounted ones alone.
 */

/**
 * wagmi's read and balance keys, as prefixes — `['readContract', {...}]`,
 * `['readContracts', {...}]`, `['balance', {...}]`. Prefix matching means one
 * entry covers every argument combination in the app. `readContract` does not
 * match `readContracts`: keys compare element by element, so both are listed.
 */
const READS = [["readContract"], ["readContracts"], ["balance"]];

/** Our own bounded `eth_getLogs` scans, keyed in lib/trades.ts and lib/stats.ts. */
const SCANS = [["trades"], ["market-volume"]];

function invalidate(qc: QueryClient, keys: string[][]) {
  for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
}

/**
 * Refresh everything the chain can have changed — reads, balances and the log
 * scans. For after a transaction of ours confirms, where the extra `getLogs` is
 * worth it because the trade is certainly not in the last scan's results.
 */
export function useChainRefresh() {
  const qc = useQueryClient();
  return useCallback(() => invalidate(qc, [...READS, ...SCANS]), [qc]);
}

/**
 * How often each tab asks our own route for the head.
 *
 * The same 2s the wagmi watcher used, so nothing about how live the app feels has
 * moved. What changed is who answers: `/api/head` is an edge hit rather than an
 * `eth_blockNumber`, so a thousand tabs polling at this rate cost the RPC about one
 * read a second instead of five hundred.
 *
 * This is the knob if edge requests ever become the thing worth optimising — a
 * thousand tabs at 2s is tens of millions of requests a day, cheap each and not
 * free in total. The cheaper shape after this one is a single server-side
 * subscription pushing over SSE, worth building when the poll is actually the
 * bottleneck: it trades a stateless cache hit for a connection held open per
 * visitor, which is the thing serverless functions are worst at.
 */
const HEAD_POLL = 2_000;

/**
 * The head, from our route rather than from the visitor's RPC.
 *
 * Deliberately with no fallback to a direct `eth_blockNumber` when the route
 * fails. That sounds like the cautious choice and is the opposite of one: the
 * moment our origin is struggling is precisely the moment every open tab would
 * turn around and poll the RPC itself, which is the stampede this route exists to
 * prevent. What happens instead is a graceful loss of liveness — nothing
 * invalidates, so every read falls back to its own `refetchInterval` (8–12s) and
 * the page goes slower rather than wrong.
 *
 * One behavioural change worth knowing about: React Query pauses
 * `refetchInterval` while the document is hidden, which wagmi's watcher did not.
 * A backgrounded tab now stops following the head altogether — cheaper, and
 * covered on the way back by `refetchOnWindowFocus` in app/providers.tsx, plus
 * `useChainRefresh()` for the case that actually matters: a transaction of ours
 * confirming while the wallet had the screen.
 */
function useHead(): bigint | undefined {
  const chainId = useChainId();

  const { data } = useQuery({
    // `['head']` is under no prefix in READS or SCANS, so this cannot invalidate
    // the query that drives it — the same property `['blockNumber']` had.
    queryKey: ["head", chainId],
    queryFn: ({ signal }) =>
      getJson(
        `/api/head?chain=${chainId}`,
        (raw) => big((raw as { block?: unknown }).block),
        signal,
      ),
    refetchInterval: HEAD_POLL,
    // Below the QueryClient's 4s default on purpose: a tab returning from a wallet
    // popup should get a real fetch out of `refetchOnWindowFocus`, not a cache hit.
    staleTime: HEAD_POLL,
  });

  return data;
}

/**
 * Mounted once under the providers. Follows the head and re-reads contract state
 * on every new block, so balances, positions, reserves and prices track the chain
 * instead of a timer.
 *
 * The log scans are deliberately excluded — see the module note.
 */
export function HeadSync() {
  const qc = useQueryClient();
  const block = useHead();

  useEffect(() => {
    if (block === undefined) return;
    invalidate(qc, READS);
  }, [block, qc]);

  return null;
}
