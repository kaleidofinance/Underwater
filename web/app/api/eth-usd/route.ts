import { NextResponse } from "next/server";

/**
 * The current ETH/USD spot rate, for the app's dollar figures.
 *
 * Why a server route and not a direct client fetch: it lets the app cache the
 * upstream call so the whole site makes one request a minute, not one per visitor
 * per component, and it keeps the price source swappable without touching the UI.
 * Nothing here is secret — these are public, keyless quotes — the win is the
 * shared cache and a single shape the client can rely on: `{ usd: number }`.
 *
 * Several sources, tried in order, so a hiccup at one does not blank out every
 * price on the site. Each attempt is bounded by a timeout: an endpoint that hangs
 * (DNS black hole, network partition) is abandoned and the next is tried, so one
 * unreachable exchange can never stall the route for tens of seconds.
 */
export const runtime = "nodejs";
export const revalidate = 60;

const SOURCES: { url: string; pick: (j: unknown) => number }[] = [
  {
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    pick: (j) => Number((j as { data?: { amount?: string } })?.data?.amount),
  },
  {
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    pick: (j) => Number((j as { ethereum?: { usd?: number } })?.ethereum?.usd),
  },
  {
    url: "https://api.kraken.com/0/public/Ticker?pair=ETHUSD",
    pick: (j) =>
      Number((j as { result?: { XETHZUSD?: { c?: string[] } } })?.result?.XETHZUSD?.c?.[0]),
  },
];

/** A source that has not answered in this long is treated as down and skipped. */
const TIMEOUT_MS = 2500;
/** How long a fetched rate is served before the next request refreshes it. */
const CACHE_MS = 60_000;

/**
 * Last good rate, held in module scope so it survives across requests in a warm
 * server. Two jobs: after the first read the route answers instantly and the
 * exchanges see one call a minute regardless of traffic; and it is the fallback
 * when every source is briefly unreachable — a minute-old price beats a blank one
 * that drops the whole site back to gwei.
 */
let cached: { usd: number; at: number } | null = null;

async function fetchRate(): Promise<number | null> {
  for (const source of SOURCES) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      // `next.revalidate` lets a production deploy serve this from the data cache;
      // `signal` bounds the wait on a cache miss so a dead host fails over fast.
      const res = await fetch(source.url, {
        headers: { accept: "application/json" },
        signal: ac.signal,
        next: { revalidate: 60 },
      });
      if (!res.ok) throw new Error(`upstream ${res.status}`);
      const usd = source.pick(await res.json());
      if (Number.isFinite(usd) && usd > 0) return usd;
      throw new Error("no usable number in response");
    } catch (err) {
      console.error(
        `[eth-usd] ${source.url} failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function GET() {
  const now = Date.now();

  // Fresh memo: skip the network entirely.
  if (cached && now - cached.at < CACHE_MS) {
    return NextResponse.json({ usd: cached.usd }, { headers: cacheHeaders });
  }

  const usd = await fetchRate();
  if (usd != null) {
    cached = { usd, at: now };
    return NextResponse.json({ usd }, { headers: cacheHeaders });
  }

  // Every source failed. Serve the last good price if we have one — stale is far
  // better UX than blank. Only truly give up on a cold server that never had one.
  if (cached) {
    return NextResponse.json(
      { usd: cached.usd, stale: true },
      { headers: cacheHeaders },
    );
  }
  return NextResponse.json({ error: "rate unavailable" }, { status: 502 });
}

const cacheHeaders = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};
