import { NextResponse } from "next/server";
import { cached, cacheHeaders, chainFrom, serverClient } from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * The chain head, read once for everybody.
 *
 * This is the cheapest read in the app and it was the most duplicated. `HeadSync`
 * follows the head so that every balance, reserve and price on the page tracks the
 * chain instead of its own timer — an unambiguously good design that happens to
 * put an `eth_blockNumber` every two seconds in *each* open tab. A few hundred
 * concurrent visitors is a few hundred requests a second for a single number that
 * is the same for all of them.
 *
 * So: one read per second per region, and the edge serves the rest. The number is
 * identical for every visitor on a chain, it is worthless the moment it is stale,
 * and it has no per-address component — the ideal thing to put behind a shared
 * cache, and the reason this route is the first one.
 *
 * See lib/refresh.ts for the client half, and lib/server-rpc.ts for why there are
 * two caches rather than one.
 *
 * "The edge serves the rest" is a claim about the *platform*, and it is now true of
 * both. On Vercel the header below is the whole mechanism. On Cloudflare it used to be
 * the case that nothing stored a Worker's own response unless the Worker stored it
 * itself, which is why this handler was briefly wrapped in a hand-rolled Cache API
 * layer. Cloudflare's Workers Caching removed the need: it is read-through, sits in
 * front of the entrypoint, and decides cacheability from this very `Cache-Control`.
 * It is turned on in wrangler.jsonc, not in application code — so there is one code
 * path for both hosts again, and `s-maxage` plus `stale-while-revalidate` mean the
 * same thing on each.
 */
export const runtime = "nodejs";
// Dynamic, not ISR, for exactly the reason /api/eth-usd spells out: a route-level
// `revalidate` export makes Next prerender this at build time, which the Vercel
// prebuilt builder cannot reconcile with the revalidation lambda ("Unable to find
// lambda for route"). The sharing win comes from the CDN header below, not from ISR.
export const dynamic = "force-dynamic";

/**
 * Ink produces a block about every second, so a one-second memo is the floor
 * worth having: shorter buys nothing a caller could observe, and anything longer
 * would make the whole site lag the chain by that much.
 */
const MEMO_MS = 1_000;
/** The edge window, and how long it may keep serving while it refreshes. */
const EDGE_S = 1;
const SWR_S = 5;

export type Head = { chainId: number; block: bigint };

export async function GET(req: Request) {
  const chain = chainFrom(new URL(req.url));
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  try {
    const { value, stale } = await cached<Head>(
      `head:${chain.id}`,
      MEMO_MS,
      async () => ({
        chainId: chain.id,
        // `cacheTime: 0` because viem caches `getBlockNumber` for `cacheTime`,
        // which defaults to the client's `pollingInterval` — a four-second default
        // sitting behind a one-second memo, which would quietly make this route the
        // slowest part of the chain it is reporting on. app/providers.tsx sets the
        // same override on the browser's config, for the same reason.
        block: await serverClient(chain).getBlockNumber({ cacheTime: 0 }),
      }),
    );

    const body: Wire<Head> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // Only reachable on a cold instance that has never had an answer — `cached`
    // serves the last known head through an outage. Logged because at that point
    // every read in every browser has stopped refreshing, and nothing else in the
    // system would say so.
    console.error(
      `[head] chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
