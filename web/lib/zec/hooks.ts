"use client";

/**
 * React Query hooks over the ZEC API. One live stream (useZecLive, mounted
 * once in the ZEC shell) invalidates what a trade or launch changed, so
 * pages show new trades within the second instead of on a poll.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  zecGet,
  zecSigned,
  zecStream,
  type ZecCandle,
  type ZecMe,
  type ZecReserves,
  type ZecStats,
  type ZecToken,
  type ZecTokenDetail,
  type ZecTrade,
} from "./api";
import { loadOrCreateKey, type ZecKey } from "./key";

export const zecKeys = {
  all: ["zec"] as const,
  tokens: ["zec", "tokens"] as const,
  token: (id: string) => ["zec", "token", id] as const,
  trades: (id: string) => ["zec", "trades", id] as const,
  candles: (id: string, interval: number) => ["zec", "candles", id, interval] as const,
  stats: ["zec", "stats"] as const,
  reserves: ["zec", "reserves"] as const,
  me: (account: string) => ["zec", "me", account] as const,
};

export function useZecTokens() {
  return useQuery({ queryKey: zecKeys.tokens, queryFn: () => zecGet<ZecToken[]>("/api/tokens"), refetchInterval: 30_000 });
}

export function useZecToken(id: string) {
  return useQuery({ queryKey: zecKeys.token(id), queryFn: () => zecGet<ZecTokenDetail>(`/api/tokens/${id}`), refetchInterval: 30_000 });
}

export function useZecTrades(id: string) {
  return useQuery({ queryKey: zecKeys.trades(id), queryFn: () => zecGet<ZecTrade[]>(`/api/tokens/${id}/trades?limit=60`) });
}

export function useZecCandles(id: string, interval: number) {
  return useQuery({
    queryKey: zecKeys.candles(id, interval),
    queryFn: () => zecGet<ZecCandle[]>(`/api/tokens/${id}/candles?interval=${interval}`),
  });
}

export function useZecStats() {
  return useQuery({ queryKey: zecKeys.stats, queryFn: () => zecGet<ZecStats>("/api/stats"), refetchInterval: 30_000 });
}

export function useZecReserves() {
  return useQuery({ queryKey: zecKeys.reserves, queryFn: () => zecGet<ZecReserves>("/api/reserves"), refetchInterval: 60_000 });
}

/** This browser's account key; null until WebCrypto has loaded or made it. */
export function useZecKey(): ZecKey | null {
  const [key, setKey] = useState<ZecKey | null>(null);
  useEffect(() => {
    let live = true;
    loadOrCreateKey()
      .then((k) => live && setKey(k))
      .catch(() => live && setKey(null));
    return () => {
      live = false;
    };
  }, []);
  return key;
}

export function useZecMe(key: ZecKey | null) {
  return useQuery({
    queryKey: zecKeys.me(key?.account ?? "none"),
    queryFn: () => zecSigned<ZecMe>("GET", "/api/me"),
    enabled: key !== null,
    // Deposits confirm on the chain's clock, not on anything this page does.
    refetchInterval: 15_000,
  });
}

/** Mount once: live trades and launches invalidate exactly what they touched. */
export function useZecLive(): void {
  const qc = useQueryClient();
  useEffect(
    () =>
      zecStream({
        trade: (t) => {
          void qc.invalidateQueries({ queryKey: zecKeys.token(t.token) });
          void qc.invalidateQueries({ queryKey: zecKeys.trades(t.token) });
          void qc.invalidateQueries({ queryKey: ["zec", "candles", t.token] });
          void qc.invalidateQueries({ queryKey: zecKeys.tokens });
          void qc.invalidateQueries({ queryKey: zecKeys.stats });
          void qc.invalidateQueries({ queryKey: ["zec", "me"] });
        },
        token: () => {
          void qc.invalidateQueries({ queryKey: zecKeys.tokens });
          void qc.invalidateQueries({ queryKey: zecKeys.stats });
        },
      }),
    [qc],
  );
}
