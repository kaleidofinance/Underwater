import type { Address } from "viem";
import { launchpadAbi } from "./abis";
import { MARKET_LIMIT } from "./market";
import type { ServerClient } from "./server-rpc";

/**
 * Launchpad reads that more than one route needs.
 *
 * The token list, twice over: a window of it for the pages that show a page of the
 * market, and all of it for the totals that would be wrong if they covered only a
 * window. Both earn a module because getting them in the fewest round trips takes a
 * trick worth explaining once rather than copying.
 */

/**
 * The newest `MARKET_LIMIT` launches, newest first, and the total.
 *
 * `tokensSlice` is newest-*last*, so the newest page is the tail — which normally
 * means reading `tokenCount` first and only then knowing which slice to ask for:
 * two sequential round trips, and against a public endpoint a round trip is most of
 * a second. So the common case is bet on instead. `tokensSlice(0, MARKET_LIMIT)` is
 * issued in the same tick as the count, and while the launchpad has no more
 * launches than the window that speculative read *is* the whole list. Only once
 * there are more does the tail cost a second round.
 *
 * Safe to speculate because the contract clamps rather than reverting:
 * `if (start >= total) return empty; if (end > total) end = total;`
 * (src/UnderwaterLaunchpad.sol). A window wider than the market is not an error
 * there, which is what makes the bet free.
 *
 * Create any other promise you want in this round *before* calling this — the two
 * reads inside go out in one tick, and `batch: true` folds whatever else was
 * created in the same tick into the same POST.
 */
export async function newestTokens(
  client: ServerClient,
  launchpad: Address,
): Promise<{ tokenCount: bigint; tokens: Address[] }> {
  const common = { address: launchpad, abi: launchpadAbi } as const;
  const limit = BigInt(MARKET_LIMIT);

  const [tokenCount, first] = await Promise.all([
    client.readContract({ ...common, functionName: "tokenCount" }) as Promise<bigint>,
    client.readContract({
      ...common,
      functionName: "tokensSlice",
      args: [0n, limit],
    }) as Promise<readonly Address[]>,
  ]);

  if (tokenCount === 0n) return { tokenCount, tokens: [] };

  const page =
    tokenCount > limit
      ? ((await client.readContract({
          ...common,
          functionName: "tokensSlice",
          args: [tokenCount - limit, limit],
        })) as readonly Address[])
      : first;

  return { tokenCount, tokens: page.slice().reverse() };
}

/**
 * Tokens per `tokensSlice` when reading the whole list.
 *
 * The call returns an array, so one slice of ten thousand addresses is a 320 KB
 * response and a gas-limited `eth_call` on some endpoints. Five hundred is a
 * comfortable request that still makes the common case — a market smaller than one
 * page — a single read.
 */
const PAGE = 500n;

/**
 * Every launch, oldest first.
 *
 * The market list wants a window; a market-wide total wants all of them, or the
 * total is only a total of the part that happened to be on screen. Pages rather than
 * one call for the reason `PAGE` gives, and the pages are issued in one tick so
 * `batch: true` folds them into a single POST.
 *
 * No memo here: the caller decides how long a token list may be stale for, and the
 * two callers disagree — a volume aggregate can live with minutes, a page resolving
 * its own token cannot.
 */
export async function allTokens(
  client: ServerClient,
  launchpad: Address,
): Promise<{ tokenCount: bigint; tokens: Address[] }> {
  const common = { address: launchpad, abi: launchpadAbi } as const;

  const tokenCount = (await client.readContract({
    ...common,
    functionName: "tokenCount",
  })) as bigint;
  if (tokenCount === 0n) return { tokenCount, tokens: [] };

  const starts: bigint[] = [];
  for (let start = 0n; start < tokenCount; start += PAGE) starts.push(start);

  const pages = (await Promise.all(
    starts.map((start) =>
      client.readContract({
        ...common,
        functionName: "tokensSlice",
        args: [start, PAGE],
      }) as Promise<readonly Address[]>,
    ),
  )) satisfies readonly (readonly Address[])[];

  return { tokenCount, tokens: pages.flat() };
}
