import { NextResponse } from "next/server";
import type { Address, Chain } from "viem";
import { launchpadFor } from "@/lib/contracts";
import { SWAP_EVENT, swapEth, TRADE_EVENT, type SwapArgs, type TradeArgs } from "@/lib/events";
import type { Volume } from "@/lib/scans";
import { dexFor, pairsFor, quotesFor } from "@/lib/server-dex";
import { newestTokens } from "@/lib/server-launchpad";
import {
  cached,
  cacheHeaders,
  chainFrom,
  serverClient,
} from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * What the market did, scanned once for everybody.
 *
 * The number under "Volume" on the home page, and it used to be read by every tab
 * that had the home page open: an unfiltered `Trade` scan over a hundred thousand
 * blocks plus one multi-address `Swap` scan over the pairs, every twenty seconds.
 * One figure, identical for every visitor on a chain, computed from scratch per tab.
 *
 * Two things change besides where it runs. The pair set is resolved here instead of
 * being handed in, which is what removes it from the cache key — the browser's
 * version keyed on the sorted pair list, so two tabs whose market reads landed a
 * moment apart were two separate scans of the same chain. And the set is now every
 * graduated launch in the newest `MARKET_LIMIT` rather than whatever slice the
 * calling component happened to be rendering, which finally makes the pool half as
 * market-wide as the curve half has always been (the `Trade` scan carries no token
 * filter and never did).
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * The window the browser asked for, kept so the number does not move underfoot.
 *
 * `WIDE` does not reach on Ink's public endpoints — they refuse any range over ten
 * thousand blocks — so in practice this scan covers `NARROW` and says so through
 * `allTime: false` and the block count. See the note on `DEPTHS` in lib/scans.ts.
 */
const WIDE = 100_000n;
const NARROW = 9_000n;

/**
 * Twenty seconds, matching the interval the hook already polled at.
 *
 * The loosest window of the four routes, because this is the number least sensitive
 * to being slightly behind: a market-wide total over a hundred thousand blocks does
 * not visibly change in twenty seconds, and it is the second-dearest read in the app
 * after the per-token feed.
 */
const MEMO_MS = 20_000;
const EDGE_S = 20;
const SWR_S = 120;

async function readVolume(chain: Chain, launchpad: Address): Promise<Volume> {
  const client = serverClient(chain);

  // Round 1: the launch list, with the DEX resolution and the head riding along.
  const dex = dexFor(client, chain.id, launchpad);
  const head = client.getBlockNumber();
  const { tokens } = await newestTokens(client, launchpad);
  const latest = await head;

  // The graduated ones' pairs. Reserves come along unused — `quotesFor` reads them
  // in the same round as the `token0` this actually needs, and which leg of a `Swap`
  // is ETH should be decided in exactly one place.
  const resolved = await dex;
  const live = await pairsFor(client, resolved, tokens);
  const quotes = await quotesFor(client, resolved.weth, live);
  const pairs = Object.values(quotes);

  // Anvil starts at block 0 and caps nothing, so scan the whole chain.
  const windows = chain.id === 31337 ? [latest] : [WIDE, NARROW];

  let lastError: unknown;
  for (const span of windows) {
    const from = span >= latest ? 0n : latest - span;
    try {
      const [curve, pool] = await Promise.all([
        // No `args` filter: this is every token's trades, not one token's.
        client.getLogs({
          address: launchpad,
          event: TRADE_EVENT,
          fromBlock: from,
          toBlock: latest,
        }),
        pairs.length
          ? client.getLogs({
              // One call for every pair at once — `eth_getLogs` takes a list of
              // addresses, and a request per pair would not scale.
              address: pairs.map((p) => p.pair),
              event: SWAP_EVENT,
              fromBlock: from,
              toBlock: latest,
            })
          : [],
      ]);

      const wethSide = new Map(
        pairs.map((p) => [p.pair.toLowerCase(), p.wethIsToken0]),
      );

      let eth = 0n;
      for (const log of curve) {
        // The curve-side ETH, which is the trade minus its fee. Volume, not
        // revenue — the fee is counted where it is charged, not here.
        eth += (log.args as TradeArgs).ethAmount ?? 0n;
      }
      for (const log of pool) {
        const wethIsToken0 = wethSide.get(log.address.toLowerCase());
        if (wethIsToken0 === undefined) continue;
        eth += swapEth(log.args as SwapArgs, wethIsToken0);
      }

      return {
        eth,
        trades: curve.length + pool.length,
        blocks: latest - from,
        allTime: from === 0n,
      };
    } catch (e) {
      // The endpoint refusing the range, nearly always — hence a narrower window to
      // try rather than an error to report. Logged because a refusal and a bug in the
      // scan look identical from outside once the fallback has quietly succeeded, and
      // a silent narrowing turns "what the market did" into a tenth of it.
      console.warn(
        `[volume] ${span} blocks refused on chain ${chain.id}:`,
        e instanceof Error ? e.message : e,
      );
      lastError = e;
    }
  }
  throw lastError;
}

export async function GET(req: Request) {
  const chain = chainFrom(new URL(req.url));
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  try {
    const { value, stale } = await cached<Volume>(
      `volume:${chain.id}`,
      MEMO_MS,
      () => readVolume(chain, launchpad),
    );

    const body: Wire<Volume> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    // Both windows refused, or a cold instance with no node. MarketStats renders
    // "this RPC would not serve the range" and the other three cards are unaffected.
    console.error(
      `[volume] chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
