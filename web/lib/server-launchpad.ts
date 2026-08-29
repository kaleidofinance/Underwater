import type { Address } from "viem";
import { launchpadAbi } from "./abis";
import { MARKET_LIMIT } from "./market";
import type { ServerClient } from "./server-rpc";

/**
 * Launchpad reads that more than one route needs.
 *
 * Only the token list so far, and it earns a module because two routes want it and
 * getting it in one round trip instead of two takes a trick that should be
 * explained once rather than copied.
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
