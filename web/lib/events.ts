import { launchpadAbi, pairAbi } from "./abis";

/**
 * The two events a token's life is recorded in, pulled off the generated ABIs so
 * a topic can never drift from the deployed contracts.
 *
 * They live here rather than beside either reader because both the trade feed and
 * the market-wide volume scan need the same pair, and a second hand-rolled copy
 * is exactly how a topic hash goes stale without anyone noticing.
 */
export const TRADE_EVENT = (() => {
  const found = launchpadAbi.find(
    (item) => item.type === "event" && item.name === "Trade",
  );
  if (!found) throw new Error("Trade event missing from launchpad ABI");
  return found;
})() as Extract<(typeof launchpadAbi)[number], { type: "event" }>;

export const SWAP_EVENT = (() => {
  const found = pairAbi.find(
    (item) => item.type === "event" && item.name === "Swap",
  );
  if (!found) throw new Error("Swap event missing from pair ABI");
  return found;
})() as Extract<(typeof pairAbi)[number], { type: "event" }>;

/**
 * `Sync(reserve0, reserve1)` — the pair's reserves after every change to them.
 *
 * Needed because `Swap` reports the amounts that moved but not the state they
 * left behind, so a swap log on its own cannot say what the price *became*. The
 * pair emits `Sync` immediately before `Swap` in the same transaction, which
 * makes the pool half of a price chart exact rather than inferred.
 */
export const SYNC_EVENT = (() => {
  const found = pairAbi.find(
    (item) => item.type === "event" && item.name === "Sync",
  );
  if (!found) throw new Error("Sync event missing from pair ABI");
  return found;
})() as Extract<(typeof pairAbi)[number], { type: "event" }>;

/**
 * Decoded shape of a launchpad `Trade`. Logs arrive loosely typed.
 *
 * The reserves and the running total are in the event on purpose — see the
 * contract's note on it — so price, market cap and curve progress at the moment
 * of each trade all come out of the log with no follow-up call.
 */
export type TradeArgs = {
  token?: `0x${string}`;
  trader?: `0x${string}`;
  isBuy?: boolean;
  ethAmount?: bigint;
  tokenAmount?: bigint;
  feeAmount?: bigint;
  ethReserve?: bigint;
  tokenReserve?: bigint;
  realEthRaised?: bigint;
  timestamp?: bigint;
};

/** Decoded shape of a pair `Swap`. Which leg is ETH depends on token order. */
export type SwapArgs = {
  amount0In?: bigint;
  amount1In?: bigint;
  amount0Out?: bigint;
  amount1Out?: bigint;
  to?: `0x${string}`;
};

/** Decoded shape of a pair `Sync`. */
export type SyncArgs = {
  reserve0?: bigint;
  reserve1?: bigint;
};

/**
 * The ETH that moved in one swap, whichever direction it went.
 *
 * On any single swap exactly one of the ETH-side legs is non-zero — ETH in on a
 * buy, ETH out on a sell — so adding both counts the trade once.
 */
export function swapEth(args: SwapArgs, wethIsToken0: boolean): bigint {
  return wethIsToken0
    ? (args.amount0In ?? 0n) + (args.amount0Out ?? 0n)
    : (args.amount1In ?? 0n) + (args.amount1Out ?? 0n);
}
