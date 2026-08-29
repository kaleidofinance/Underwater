import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { launchpadAbi, memeTokenAbi } from "@/lib/abis";
import { CURVE, launchpadFor } from "@/lib/contracts";
import { marketCapWei, progressBps, spotPriceE18 } from "@/lib/curve";
import {
  decodePool,
  priceSource,
  type Listing,
  type MarketState,
  type PoolQuote,
} from "@/lib/market";
import { dexFor, pairsFor, quotesFor, settle } from "@/lib/server-dex";
import { newestTokens } from "@/lib/server-launchpad";
import { cached, cacheHeaders, chainFrom, serverClient } from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * The market, read once for everybody.
 *
 * This is the expensive one. `useListings` was 40 tokens × 4 reads plus a second
 * round for the graduated ones, re-run on every new block because lib/refresh.ts
 * invalidates contract reads when the head moves — a correct design that costs one
 * ~160-call `aggregate3` per tab per block. /swap and /profile ask for 100, so 400.
 * Multiply by a few hundred concurrent visitors and the numbers stop being
 * reasonable: it is the same answer, computed from scratch per tab, against an RPC
 * that rate-limits per IP.
 *
 * None of it is per-visitor. Reserves, names, prices, market caps and progress are
 * identical for everyone looking at the same chain in the same second, which makes
 * this exactly the shape lib/server-rpc.ts describes: read once behind a CDN, let
 * the edge serve the fan-out. The derivations run here too (lib/curve.ts is pure,
 * so it runs either side), which means the payload is final — the browser does no
 * arithmetic on it and cannot disagree with the next tab about a price.
 *
 * Still direct from the wallet's own RPC, deliberately: `balanceOf`, `allowance`,
 * `useBalance`, and every quote a trade is signed against. What is shared here is
 * what the page *shows*.
 *
 * **The shape of the read.** Each `await`-separated phase above is one RPC round
 * trip, and a round trip to a public endpoint is measured in seconds, not
 * milliseconds. The data dependency chain allows four of them: count + router →
 * token slice + factory/WETH → per-token fields + pair lookups → reserves. That is
 * the floor for this ABI, and it is why the two-phase pair dance is ordered the way
 * it is — `getPair` needs `weth` but not the pool decode, so it joins the per-token
 * round rather than waiting for it.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/** Reads per token: pool, name, symbol, metadata URI. */
const PER_LISTING = 4;

/**
 * The memo, the edge window, and how long the edge may serve while it refreshes.
 *
 * Three seconds, where the head gets one. The head is a single `eth_blockNumber`
 * and worthless the moment it is stale; this is several hundred calls and four
 * round trips, and nothing on the page is improved by a market list that is 3s
 * fresher. `HeadSync` still invalidates the client query on every block, so a tab
 * asks this often — it is just answered at the edge most times, which is the whole
 * mechanism. Between the memo, the CDN window and the edge refreshes, the origin
 * pays for this read roughly once per window per region.
 *
 * The 30s `stale-while-revalidate` is doing real work: it means an RPC hiccup shows
 * as a market a few seconds behind rather than an empty page, and no visitor ever
 * waits on the round trips once the first one has landed.
 */
const MEMO_MS = 3_000;
const EDGE_S = 3;
const SWR_S = 30;

async function readMarket(chain: Chain, launchpad: Address): Promise<MarketState> {
  const client = serverClient(chain);
  const common = { address: launchpad, abi: launchpadAbi } as const;

  // Round 1. The DEX promise is created first so its router read joins this same
  // tick — `batch: true` folds same-tick reads into one POST, and `newestTokens`
  // issues both of its own reads in that same tick.
  const dex = dexFor(client, chain.id, launchpad);
  const { tokenCount, tokens } = await newestTokens(client, launchpad);

  const base = { chainId: chain.id, launchpad, tokenCount };
  if (tokens.length === 0) return { ...base, listings: [] };

  // Round 2. The per-token fields and the pair lookups go in one tick: `getPair`
  // needs `weth` (round 1's DEX read, already settled) and nothing from the pool
  // decode, so waiting for the pools would only cost another round trip. The
  // zero-address results for pre-graduation tokens are dropped after.
  const { factory, weth } = await dex;
  const [rows, live] = await Promise.all([
    settle(
      tokens.flatMap((token) => [
        client.readContract({ ...common, functionName: "pools", args: [token] }),
        client.readContract({
          address: token,
          abi: memeTokenAbi,
          functionName: "name",
        }),
        client.readContract({
          address: token,
          abi: memeTokenAbi,
          functionName: "symbol",
        }),
        client.readContract({
          address: token,
          abi: memeTokenAbi,
          functionName: "metadataURI",
        }),
      ]),
    ),
    pairsFor(client, { factory, weth }, tokens),
  ]);

  // Round 3 — only in the rare case the DEX resolved and some token has a pair.
  // Spent on pricing here and not shipped: see the note on `MarketState`.
  const quotes: Record<string, PoolQuote> = await quotesFor(client, weth, live);

  const listings: Listing[] = [];
  tokens.forEach((token, i) => {
    const pool = decodePool(rows[i * PER_LISTING]);
    if (!pool || !pool.exists) return;
    const at = i * PER_LISTING;
    const name = rows[at + 1];
    const symbol = rows[at + 2];
    const uri = rows[at + 3];
    const { ethReserve, tokenReserve, fromPool } = priceSource(
      pool,
      quotes[token.toLowerCase()],
    );
    listings.push({
      token,
      // The same em-dash the rows used to fall back to locally, kept here so the
      // payload is what renders — a listing whose `name()` reverted still has a row.
      name: typeof name === "string" ? name : "—",
      symbol: typeof symbol === "string" ? symbol : "—",
      metadataURI: typeof uri === "string" ? uri : "",
      pool,
      priceE18: spotPriceE18(ethReserve, tokenReserve),
      marketCap: marketCapWei(ethReserve, tokenReserve, CURVE.totalSupply),
      progress: progressBps(
        pool.realEthRaised,
        CURVE.graduationEth,
        pool.graduated,
      ),
      fromPool,
    });
  });

  return { ...base, listings };
}

export async function GET(req: Request) {
  const chain = chainFrom(new URL(req.url));
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  // Nothing to read. The client half never asks in this state — `useLaunchpad`
  // reports `configured: false` and the page renders `NotDeployed` — so this is
  // for a direct request, and 404 is the honest answer to "the market on a chain
  // we have not deployed to".
  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  try {
    const { value, stale } = await cached<MarketState>(
      `market:${chain.id}`,
      MEMO_MS,
      () => readMarket(chain, launchpad),
    );

    const body: Wire<MarketState> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // Only on a cold instance with no answer to fall back on — `cached` serves the
    // last known market through an outage. Logged because at this point the market
    // page is empty for everyone in this region and nothing else would say so.
    console.error(
      `[market] chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
