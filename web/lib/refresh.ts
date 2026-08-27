"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useBlockNumber } from "wagmi";

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
 *   reach.
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
 * Mounted once under the providers. Follows the head and re-reads contract state
 * on every new block, so balances, positions, reserves and prices track the chain
 * instead of a timer.
 *
 * The log scans are deliberately excluded — see the module note. `useBlockNumber`
 * is keyed under `['blockNumber']`, which is in neither list, so this cannot
 * invalidate its own watcher.
 */
export function HeadSync() {
  const qc = useQueryClient();
  const { data: block } = useBlockNumber({ watch: true });

  useEffect(() => {
    if (block === undefined) return;
    invalidate(qc, READS);
  }, [block, qc]);

  return null;
}
