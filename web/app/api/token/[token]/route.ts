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
 *
 * An address lookup, and not a launch lookup: `pool: null` beside a non-null `pair`
 * is a token the launchpad never minted, trading in a pool somebody paired against
 * WETH on our factory. `readToken` prices that off the pair like any other pool, and
 * the token page renders it as its own thing rather than "no launch here" — see the
 * imported branch below.
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
    // Absent on anything the launchpad did not mint: `metadataURI` is ours, and a
    // foreign ERC-20 reverts on it. `settle` turns that into `undefined`, which
    // falls through to "" here and reads downstream as "no art was ever set" — the
    // same state a launch that skipped it is in.
    metadataURI: typeof rows[3] === "string" ? rows[3] : "",
    // The launchpad mints a fixed supply, so the constant is the honest fallback
    // for a read that did not answer — same default `useTokenDetail` used.
    totalSupply: typeof rows[4] === "bigint" ? rows[4] : CURVE.totalSupply,
  };

  // A live curve: the curve's own reserves are the price and there is no pair yet.
  // Skipping the pair rounds entirely is most of what makes this route cheap for the
  // common case, and the common case is a token still on its curve.
  if (pool && !pool.graduated) {
    return {
      ...base,
      pool,
      pair: null,
      priceE18: spotPriceE18(pool.ethReserve, pool.tokenReserve),
      marketCap: marketCapWei(pool.ethReserve, pool.tokenReserve, CURVE.totalSupply),
      progress: progressBps(pool.realEthRaised, CURVE.graduationEth, pool.graduated),
      fromPool: false,
    };
  }

  // Everything else is priced by a pair, if one exists: a graduated launch, whose
  // curve reserves are frozen at their final values forever, and an *imported*
  // token — one the launchpad never minted, which somebody has since paired against
  // WETH on our factory. `createPair` is unpermissioned, so that is a thing anyone
  // can do, and until this branch existed the two cases were told apart by asking
  // the launchpad rather than the DEX: a token with no pool read as unpriced even
  // with liquidity sitting in front of it.
  const resolved = await dex;
  const live = await pairsFor(client, resolved, [token]);
  const quotes = await quotesFor(client, resolved.weth, live);
  const pair = quotes[token.toLowerCase()] ?? null;

  // No launch and no pair: nothing to price, and the page says so. Reported as a
  // token rather than a 404 because "this address is not traded here" is an answer,
  // and the caller may well have just pasted a contract from another chain.
  if (!pool) {
    return {
      ...base,
      pool: null,
      pair,
      priceE18: pair ? spotPriceE18(pair.ethReserve, pair.tokenReserve) : 0n,
      // Its own supply, not `CURVE.totalSupply`. An imported token mints whatever it
      // likes, and multiplying its price by our launchpad's fixed 1B would state a
      // market cap off by whatever the ratio happens to be.
      marketCap: pair
        ? marketCapWei(pair.ethReserve, pair.tokenReserve, base.totalSupply)
        : 0n,
      progress: 0,
      // True whenever there is a price at all here, since the pair is the only place
      // one could have come from.
      fromPool: !!pair,
    };
  }

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
