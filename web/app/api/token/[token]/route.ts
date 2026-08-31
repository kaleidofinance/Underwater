import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address, type Chain } from "viem";
import { launchpadAbi, memeTokenAbi } from "@/lib/abis";
import { CURVE, launchpadFor } from "@/lib/contracts";
import { marketCapWei, progressBps, spotPriceE18 } from "@/lib/curve";
import {
  decodePool,
  priceSource,
  type TokenState,
} from "@/lib/market";
import { dexFor, pairsFor, quotesFor, settle } from "@/lib/server-dex";
import { cached, cacheHeaders, chainFrom, serverClient } from "@/lib/server-rpc";
import { encodeWire, type Wire } from "@/lib/wire";

/**
 * One token's shared state, read once for everybody.
 *
 * `useTokenDetail` batched seven reads and refreshed on every block, and five of
 * the seven were the same for every visitor: the pool struct, the name, the symbol,
 * the metadata URI, the total supply. The other two — `balanceOf` and `allowance` —
 * are one wallet's and cannot be shared by construction. So the batch splits along
 * that line: this route serves the five, the browser keeps reading the two.
 *
 * Which is the whole principle, stated once more because the token page is where it
 * is easiest to get wrong: what the page *shows* about a token is public and
 * cacheable, what it shows about *you* is not, and what it *signs* is neither —
 * `useQuote` and the router's `getAmountsOut` still go straight to the chain
 * immediately before a transaction, so no trade is ever priced off a cached number.
 *
 * Deliberately not derived from `/api/market`'s payload. A token outside the newest
 * `MARKET_LIMIT` still has a page, and that page has to work — the market document
 * is a window, this is an address lookup.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * Same 3s as the market. This is what the token page's price, reserves and progress
 * bar track, and it is the read a visitor is most likely staring at while a trade of
 * theirs lands.
 *
 * Which is the reason it is three and not ten. `useChainRefresh()` invalidates this
 * query the moment their transaction confirms, but an invalidation only forces a new
 * *request*: the edge answers it from the same document until the window rolls. So
 * this number is the delay between a trade of yours confirming and the page's price
 * agreeing with it — short enough to read as immediate, next to a balance that
 * genuinely is (it is a direct read and never cached).
 */
const MEMO_MS = 3_000;
const EDGE_S = 3;
const SWR_S = 30;

async function readToken(
  chain: Chain,
  launchpad: Address,
  token: Address,
): Promise<TokenState> {
  const client = serverClient(chain);

  // Round 1: the token's own fields, with the DEX resolution riding along — the
  // promise is created before the await so its `router()` joins the same tick.
  const dex = dexFor(client, chain.id, launchpad);
  const rows = await settle([
    client.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "pools",
      args: [token],
    }),
    client.readContract({ address: token, abi: memeTokenAbi, functionName: "name" }),
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
    client.readContract({
      address: token,
      abi: memeTokenAbi,
      functionName: "totalSupply",
    }),
  ]);

  const pool = decodePool(rows[0]);
  const base = {
    chainId: chain.id,
    token,
    name: typeof rows[1] === "string" ? rows[1] : "",
    symbol: typeof rows[2] === "string" ? rows[2] : "",
    metadataURI: typeof rows[3] === "string" ? rows[3] : "",
    // The launchpad mints a fixed supply, so the constant is the honest fallback
    // for a read that did not answer — same default `useTokenDetail` used.
    totalSupply: typeof rows[4] === "bigint" ? rows[4] : CURVE.totalSupply,
  };

  // No launch, or a live curve: either way there is no pair to read and the curve's
  // own reserves are the price. Skipping the pair rounds entirely is most of what
  // makes this route cheap for the common case.
  if (!pool || !pool.graduated) {
    const { ethReserve, tokenReserve } = pool
      ? pool
      : { ethReserve: 0n, tokenReserve: 0n };
    return {
      ...base,
      pool,
      pair: null,
      priceE18: spotPriceE18(ethReserve, tokenReserve),
      marketCap: marketCapWei(ethReserve, tokenReserve, CURVE.totalSupply),
      progress: pool
        ? progressBps(pool.realEthRaised, CURVE.graduationEth, pool.graduated)
        : 0,
      fromPool: false,
    };
  }

  // Graduated: two more rounds for the pair address and its reserves. The curve's
  // reserves are frozen at their final values, so this is the only live price.
  const resolved = await dex;
  const live = await pairsFor(client, resolved, [token]);
  const quotes = await quotesFor(client, resolved.weth, live);
  const pair = quotes[token.toLowerCase()] ?? null;

  const { ethReserve, tokenReserve, fromPool } = priceSource(
    pool,
    pair ?? undefined,
  );
  return {
    ...base,
    pool,
    pair,
    priceE18: spotPriceE18(ethReserve, tokenReserve),
    marketCap: marketCapWei(ethReserve, tokenReserve, CURVE.totalSupply),
    progress: progressBps(pool.realEthRaised, CURVE.graduationEth, pool.graduated),
    fromPool,
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const chain = chainFrom(new URL(req.url));
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  const { token: raw } = await ctx.params;
  if (!isAddress(raw)) {
    return NextResponse.json({ error: "not an address" }, { status: 400 });
  }
  // Checksummed so the cache key is one entry per token rather than one per
  // spelling of it, and so the address the payload reports back is canonical.
  const token = getAddress(raw);

  const launchpad = launchpadFor(chain.id);
  if (!launchpad) {
    return NextResponse.json({ error: "not deployed" }, { status: 404 });
  }

  try {
    const { value, stale } = await cached<TokenState>(
      `token:${chain.id}:${token.toLowerCase()}`,
      MEMO_MS,
      () => readToken(chain, launchpad, token),
    );

    const body: Wire<TokenState> & { stale?: true } = encodeWire(value);
    if (stale) body.stale = true;
    return NextResponse.json(body, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    console.error(
      `[token] ${token} on chain ${chain.id} unavailable:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "chain unavailable" }, { status: 502 });
  }
}
