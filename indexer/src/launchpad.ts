import { ponder } from "ponder:registry";
import type { Context } from "ponder:registry";
import { pair, protocolFee, token, trade } from "ponder:schema";
import type { Address } from "viem";
import { launchpadAbi, pairAbi } from "../abis/generated";
import { recordCandles } from "./candles";
import { marketCapWei, progressBps, spotPriceE18 } from "./curve";
import { credit } from "./points";

/**
 * The launchpad's three events, which are the whole curve side of the market.
 *
 * `TokenCreated`, `Trade` and `Graduated` between them describe a launch's entire life,
 * and `Trade` was written to carry its resulting reserves precisely so an indexer could
 * derive price and market cap from the log without a follow-up call — the comment
 * saying so is in `src/UnderwaterLaunchpad.sol` above the event. So the hot path here
 * makes no RPC requests at all: only creation and graduation read anything.
 */

/**
 * The launchpad's immutable parameters, once per launchpad.
 *
 * `GRADUATION_ETH` and `TOTAL_SUPPLY` are `constant` in the contract, so they are
 * genuinely fixed per deployment and a process-lifetime memo is sound — unlike a
 * cached *state* read, which would be a bug. Keyed by chain id and address together
 * because two chains can hold differently-parameterised launchpads, which is the
 * reason these are read at all rather than copied out of this repo's Solidity.
 *
 * Read as a pair in one tick so viem folds them into a single `aggregate3`.
 */
const limitsCache = new Map<string, { graduationEth: bigint; totalSupply: bigint }>();

async function curveLimits(
  context: Pick<Context, "chain" | "client">,
  launchpad: Address,
) {
  const key = `${context.chain.id}:${launchpad}`;
  const held = limitsCache.get(key);
  if (held) return held;

  const [graduationEth, totalSupply] = await Promise.all([
    context.client.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "GRADUATION_ETH",
    }),
    context.client.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "TOTAL_SUPPLY",
    }),
  ]);

  const limits = { graduationEth, totalSupply };
  limitsCache.set(key, limits);
  return limits;
}

/**
 * A new launch.
 *
 * Two reads, both of which only ever happen once per launch. `pools(token)` seeds the
 * row with the exact reserves the contract holds rather than with the virtual
 * constants this repo believes it starts from — the same argument as `curveLimits`.
 *
 * `creationFee()` is read at this block rather than tracked through
 * `CreationFeeUpdated`, which is the shorter road to the same number. It is read
 * *after* the block that contained the launch, so an owner who changed the fee in the
 * same block as a launch would have the new value attributed to it. That is a
 * one-block window on an owner action that happens roughly never, and the alternative
 * — replaying a fee-history table — is a lot of machinery for it.
 */
ponder.on("Launchpad:TokenCreated", async ({ event, context }) => {
  const launchpad = event.log.address;
  const address = event.args.token;

  const [pool, limits, creationFee] = await Promise.all([
    context.client.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "pools",
      args: [address],
    }),
    curveLimits(context, launchpad),
    context.client.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "creationFee",
    }),
  ]);

  const [ethReserve, tokenReserve, realEthRaised] = pool;

  const priceE18 = spotPriceE18(ethReserve, tokenReserve);
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(token).values({
    chainId: context.chain.id,
    address,
    creator: event.args.creator,
    name: event.args.name,
    symbol: event.args.symbol,
    metadataUri: event.args.metadataURI,
    createdAt: Number(event.args.timestamp),
    createdBlock: event.block.number,
    createdTx: event.transaction.hash,
    createdLogIndex: event.log.logIndex,

    ethReserve,
    tokenReserve,
    realEthRaised,

    graduated: false,
    graduatedAt: null,
    pair: null,

    graduationEth: limits.graduationEth,
    totalSupply: limits.totalSupply,

    priceE18,
    marketCapWei: marketCapWei(ethReserve, tokenReserve, limits.totalSupply),
    progressBps: progressBps(realEthRaised, limits.graduationEth, false),

    tradeCount: 0,
    volumeWei: 0n,
    feeWei: 0n,
    lastTradeAt: null,
  });

  // The first of the four revenue legs. Zero is a legitimate value — the creation fee
  // has been zero on both testnets — and a zero row is still worth writing: it records
  // that this launch earned nothing, which is different from not knowing.
  await context.db.insert(protocolFee).values({
    id: `${context.chain.id}-${event.block.number}-${event.log.logIndex}-creation`,
    chainId: context.chain.id,
    kind: "creation",
    token: address,
    amountWei: creationFee,
    timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  // The other thing a launch earns: `rates.create` to the creator. Written from the same
  // handler as the token row rather than from a listener on it, so there is one place
  // where "a launch happened" turns into everything that follows from it.
  await credit(context.db, context.chain.id, event.args.creator, { creates: 1 });
});

/**
 * A curve fill.
 *
 * No reads, of either kind. The event carries the reserves it left behind, so price and
 * market cap come out of the log, and the launchpad's limits come off the token row —
 * which is the difference between an indexer that keeps up with a 0.1-second chain and
 * one that makes three round trips per trade.
 *
 * `update` rather than an upsert, and the token row is therefore required to exist. It
 * always does: `create` emits `TokenCreated` (UnderwaterLaunchpad.sol:258) before it
 * calls `_buy` (:265), so even the creator's own opening buy is ordered after the row
 * that describes it, and Ponder delivers logs in `logIndex` order within a block. The
 * one way to reach this line without a row is a `START_BLOCK_<KEY>` set past a launch's
 * creation, and then throwing is the right answer — an operator who has cut off half a
 * launch's history should hear about it, not be handed a table of trades belonging to a
 * token with no name.
 */
ponder.on("Launchpad:Trade", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { token: address, trader, isBuy, ethAmount, tokenAmount, feeAmount } =
    event.args;
  const { ethReserve, tokenReserve, realEthRaised } = event.args;

  const priceE18 = spotPriceE18(ethReserve, tokenReserve);
  const timestamp = Number(event.block.timestamp);

  await context.db.insert(trade).values({
    id: `${chainId}-${event.block.number}-${event.log.logIndex}`,
    chainId,
    token: address,
    trader,
    txFrom: event.transaction.from,
    source: "curve",
    isBuy,
    ethAmount,
    tokenAmount,
    feeWei: feeAmount,
    priceE18,
    raised: realEthRaised,
    timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });

  await context.db.update(token, { chainId, address }).set((row) => ({
    ethReserve,
    tokenReserve,
    realEthRaised,
    priceE18,
    marketCapWei: marketCapWei(ethReserve, tokenReserve, row.totalSupply),
    progressBps: progressBps(realEthRaised, row.graduationEth, row.graduated),
    tradeCount: row.tradeCount + 1,
    volumeWei: row.volumeWei + ethAmount,
    feeWei: row.feeWei + feeAmount,
    lastTradeAt: timestamp,
  }));

  await context.db.insert(protocolFee).values({
    id: `${chainId}-${event.block.number}-${event.log.logIndex}-trade`,
    chainId,
    kind: "trade",
    token: address,
    amountWei: feeAmount,
    timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  await recordCandles(context.db, {
    chainId,
    token: address,
    timestamp,
    priceE18,
    ethAmount,
  });

  // A curve fill is a swap to the rate card, same as a pool one. No `isTrader` check is
  // needed on this side: `Trade.trader` is `msg.sender` on a function only an EOA-driven
  // call reaches, so it is never the router or a pair the way `Swap.to` can be.
  await credit(context.db, chainId, trader, { trades: 1 });
});

/**
 * The raise reaching the threshold and moving into a pool.
 *
 * One read, once per launch: `token0()` on the new pair. The pair holds exactly WETH
 * and this launch's token, so whichever side is not the token is WETH — which is why
 * no WETH address has to be configured anywhere in this package.
 *
 * The pair row is upserted because its own `Mint` and `Sync` are emitted earlier in
 * this same transaction: the launchpad adds liquidity and *then* announces the
 * graduation. So `Sync` may already have created the row with reserves and no link.
 *
 * The opening pool price comes from the event's own liquidity amounts rather than from
 * the pair's reserves, which are the same numbers at this instant and available without
 * a read.
 */
ponder.on("Launchpad:Graduated", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { token: address, pair: pairAddress, ethLiquidity, tokenLiquidity } =
    event.args;
  const timestamp = Number(event.block.timestamp);

  const token0 = await context.client.readContract({
    address: pairAddress,
    abi: pairAbi,
    functionName: "token0",
  });

  const wethIsToken0 = token0.toLowerCase() !== address.toLowerCase();

  await context.db
    .insert(pair)
    .values({
      chainId,
      address: pairAddress,
      token: address,
      wethIsToken0,
      reserve0: wethIsToken0 ? ethLiquidity : tokenLiquidity,
      reserve1: wethIsToken0 ? tokenLiquidity : ethLiquidity,
    })
    .onConflictDoUpdate(() => ({ token: address, wethIsToken0 }));

  const priceE18 = spotPriceE18(ethLiquidity, tokenLiquidity);

  await context.db.update(token, { chainId, address }).set((row) => ({
    graduated: true,
    graduatedAt: timestamp,
    pair: pairAddress,
    priceE18,
    marketCapWei: marketCapWei(ethLiquidity, tokenLiquidity, row.totalSupply),
    progressBps: 10_000,
  }));

  await context.db.insert(protocolFee).values({
    id: `${chainId}-${event.block.number}-${event.log.logIndex}-graduation`,
    chainId,
    kind: "graduation",
    token: address,
    amountWei: event.args.protocolFee,
    timestamp,
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
});
