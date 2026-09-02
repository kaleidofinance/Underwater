import { ponder } from "ponder:registry";
import { pair, token, trade } from "ponder:schema";
import { recordCandles } from "./candles";
import { marketCapWei, spotPriceE18 } from "./curve";
import { credit, isTrader } from "./points";

/**
 * The pool side of a launch's life, after graduation.
 *
 * Two events, and the order they arrive in is what makes this cheap. `UnderwaterPair`
 * emits `Sync` from `_update` and *then* `Swap`, in that order, in the same
 * transaction — the Uniswap V2 shape. So by the time the `Swap` handler runs, the pair
 * row already holds post-swap reserves, and the swap's resulting price needs no read
 * and no arithmetic beyond one division. That is the same convention the curve's
 * `Trade` event follows by carrying its own resulting reserves, which keeps both
 * venues' rows meaning the same thing.
 *
 * Neither handler assumes the pair is one of ours in the sense of knowing its token:
 * Ponder discovers pairs from the launchpad's `Graduated` event and begins indexing at
 * that same block, and the liquidity that creates the pool is added *before* the
 * announcement — so the first `Sync` can land before the row that says which launch
 * this pool belongs to. Both handlers tolerate that and let `Graduated` fill it in.
 */

/**
 * Reserves moved — by a swap, or by liquidity arriving or leaving.
 *
 * Handles the pair's price bookkeeping for every cause at once, which is why it is
 * here rather than folded into the `Swap` handler: the graduation's own `Mint` moves
 * the reserves from nothing to the whole raise, and a chart that ignored it would open
 * the pool era at whatever the last curve trade was.
 */
ponder.on("Pair:Sync", async ({ event, context }) => {
  const chainId = context.chain.id;
  const address = event.log.address;
  const { reserve0, reserve1 } = event.args;

  const row = await context.db
    .insert(pair)
    .values({
      chainId,
      address,
      token: null,
      wethIsToken0: null,
      reserve0,
      reserve1,
    })
    .onConflictDoUpdate(() => ({ reserve0, reserve1 }));

  // No link yet, which means this is the graduation's own liquidity landing a few logs
  // ahead of the announcement. `Graduated` sets the opening price from its own
  // arguments, so there is nothing lost by returning here.
  if (row.token === null || row.wethIsToken0 === null) return;

  const ethReserve = row.wethIsToken0 ? reserve0 : reserve1;
  const tokenReserve = row.wethIsToken0 ? reserve1 : reserve0;
  const priceE18 = spotPriceE18(ethReserve, tokenReserve);

  await context.db.update(token, { chainId, address: row.token }).set((t) => ({
    priceE18,
    marketCapWei: marketCapWei(ethReserve, tokenReserve, t.totalSupply),
  }));
});

/**
 * A pool fill, normalised into the same row a curve fill produces.
 *
 * `isBuy` is from the token's point of view, not the pool's: ETH in means somebody
 * bought the token. Getting that backwards would invert every green candle after
 * graduation, so it is derived from which side WETH sits on rather than from the sign
 * of anything.
 *
 * The two amounts are taken as `in + out` per side. Only one of each pair is ever
 * non-zero for a plain swap, and summing avoids caring which — while staying correct
 * for the multi-hop case where a pair sees both.
 *
 * `feeWei` is zero here, and that is a statement rather than a gap. The pool's 0.3% is
 * the LPs', and the protocol's sixth of it accrues as LP tokens minted to `feeTo` at
 * the next liquidity event — an amount that appears in no log and is inert anyway while
 * the graduation LP is burned. See the note on `protocolFee.kind` in ponder.schema.ts.
 */
ponder.on("Pair:Swap", async ({ event, context }) => {
  const chainId = context.chain.id;
  const address = event.log.address;
  const { amount0In, amount1In, amount0Out, amount1Out, to } = event.args;

  const row = await context.db.find(pair, { chainId, address });
  if (!row?.token || row.wethIsToken0 === null) return;

  const ethIn = row.wethIsToken0 ? amount0In : amount1In;
  const ethOut = row.wethIsToken0 ? amount0Out : amount1Out;
  const tokenIn = row.wethIsToken0 ? amount1In : amount0In;
  const tokenOut = row.wethIsToken0 ? amount1Out : amount0Out;

  const ethAmount = ethIn + ethOut;
  const tokenAmount = tokenIn + tokenOut;
  const isBuy = ethIn > 0n;

  // Post-swap reserves, already committed by the `Sync` that precedes this log.
  const ethReserve = row.wethIsToken0 ? row.reserve0 : row.reserve1;
  const tokenReserve = row.wethIsToken0 ? row.reserve1 : row.reserve0;
  const priceE18 = spotPriceE18(ethReserve, tokenReserve);
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(trade).values({
    id: `${chainId}-${event.block.number}-${event.log.logIndex}`,
    chainId,
    token: row.token,
    // The recipient, not the `sender`: `sender` is the router, which is the same
    // address for every swap and would make the trader column useless. `to` is where
    // the output went, which is the trader in every path the app builds.
    trader: to,
    // The sender, for the same swap. `to` above is the router on any sell the app makes,
    // so a trade feed labelled with it would credit a contract for a person's trade —
    // see `txFrom` in ponder.schema.ts for why both are kept rather than one resolved.
    txFrom: event.transaction.from,
    source: "pool",
    isBuy,
    ethAmount,
    tokenAmount,
    feeWei: 0n,
    priceE18,
    // Not a curve, so there is no raise. Null rather than zero: zero is what a graduated
    // curve holds, and a pool swap is not making that statement about anything.
    raised: null,
    timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });

  await context.db.update(token, { chainId, address: row.token }).set((t) => ({
    tradeCount: t.tradeCount + 1,
    volumeWei: t.volumeWei + ethAmount,
    lastTradeAt: timestamp,
  }));

  await recordCandles(context.db, {
    chainId,
    token: row.token,
    timestamp,
    priceE18,
    ethAmount,
  });

  // `rates.swap`, to whoever received the output — if that is a wallet at all. It often
  // is not: the router takes the WETH leg of a sell before unwrapping it, and a multi-hop
  // sends its intermediate output to the next pair. Crediting either would be crediting a
  // contract for a trade a user made, and on a busy chain the router's row would sit at
  // the top of the leaderboard. See `isTrader` in points.ts.
  //
  // The consequence is that buys are credited and router sells are not, which is exactly
  // what the app's own scan does today — `poolIn` in web/app/api/points/route.ts excludes
  // the same addresses and its docblock makes the same admission. A points system that
  // counted sells would need `Transfer` pairing, and neither side has done that work.
  if (await isTrader(context, to)) {
    await credit(context.db, chainId, to, { trades: 1 });
  }
});
