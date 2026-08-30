import { launchpadAbi, pairAbi, pointsAbi, waitlistAbi } from "./abis";

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
 * `Registered(who, position, at, referrer)` — the waitlist's one intake event.
 *
 * Two jobs in one log, and the reason the points system needs no ledger: the
 * registrant is `who`, the referrer is `referrer`, and both are indexed. A
 * wallet's points from the allowlist phase are entirely this event counted two
 * ways — once as `who` to see if *it* registered, once as `referrer` to see who
 * it brought in.
 */
export const REGISTERED_EVENT = (() => {
  const found = waitlistAbi.find(
    (item) => item.type === "event" && item.name === "Registered",
  );
  if (!found) throw new Error("Registered event missing from waitlist ABI");
  return found;
})() as Extract<(typeof waitlistAbi)[number], { type: "event" }>;

/** Decoded shape of a waitlist `Registered`. */
export type RegisteredArgs = {
  who?: `0x${string}`;
  position?: bigint;
  at?: bigint;
  referrer?: `0x${string}`;
};

/**
 * `TokenCreated(token, creator, name, symbol, metadataURI, timestamp)`.
 *
 * Creator is the third field but the only indexed one worth a per-address query
 * on the launchpad, so `eth_getLogs` can count them without ever pulling the
 * events apart.
 */
export const TOKEN_CREATED_EVENT = (() => {
  const found = launchpadAbi.find(
    (item) => item.type === "event" && item.name === "TokenCreated",
  );
  if (!found) throw new Error("TokenCreated event missing from launchpad ABI");
  return found;
})() as Extract<(typeof launchpadAbi)[number], { type: "event" }>;

/** Decoded shape of a launchpad `TokenCreated`. */
export type TokenCreatedArgs = {
  token?: `0x${string}`;
  creator?: `0x${string}`;
  name?: string;
  symbol?: string;
  metadataURI?: string;
  timestamp?: bigint;
};

/**
 * `Redeemed(who, codeHash, points)` and `Granted(who, points, reason)` — the two
 * ways `UnderwaterPoints.granted` ever moves.
 *
 * Exported as a pair because they are only ever read as a pair. `granted[who]` is
 * cumulative and never decremented (see the mapping's note in the contract), so the
 * sum of these two logs for an address *is* its mapping value — which turns the one
 * number an off-chain reader would have to `eth_call` per address into a log stream
 * read once for everybody. That difference is what lets /api/points rank a board
 * without a read per wallet in it.
 */
export const REDEEMED_EVENT = (() => {
  const found = pointsAbi.find(
    (item) => item.type === "event" && item.name === "Redeemed",
  );
  if (!found) throw new Error("Redeemed event missing from points ABI");
  return found;
})() as Extract<(typeof pointsAbi)[number], { type: "event" }>;

export const GRANTED_EVENT = (() => {
  const found = pointsAbi.find(
    (item) => item.type === "event" && item.name === "Granted",
  );
  if (!found) throw new Error("Granted event missing from points ABI");
  return found;
})() as Extract<(typeof pointsAbi)[number], { type: "event" }>;

/**
 * What both of them have in common, which is all a balance needs: whose it is and
 * how much. `points` is `uint64` on one and `uint256` on the other; both decode to
 * `bigint`, so neither the reader nor the sum has to care which arrived.
 */
export type GrantArgs = {
  who?: `0x${string}`;
  points?: bigint;
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
