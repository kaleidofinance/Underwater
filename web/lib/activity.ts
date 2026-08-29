import type { Address, Chain, PublicClient } from "viem";

/**
 * The "is this wallet real on Ink" bar, and the one place it is defined.
 *
 * Extracted from lib/waitlist.ts, which is `"use client"`, because three callers
 * now need the same bar and one of them is a route handler:
 *
 *  - the register form's Verify button (browser, one wallet, on demand);
 *  - `/api/points`, scoring *other people's* referrals (server, many wallets);
 *  - anything later that has to reproduce a published points snapshot.
 *
 * A second copy of the threshold is how the form ends up promising a bar the
 * leaderboard does not apply. `lib/waitlist.ts` re-exports `MIN_INK_TXNS` from
 * here, so nothing that already imported it had to change.
 */

/// How many sent transactions make a wallet "active on Ink" — ten, a wallet that
/// has actually used the chain rather than just touched it once. One of two ways to
/// pass; a DeFi position on Ink mainnet is the other.
export const MIN_INK_TXNS = 10;

/// Ink mainnet's lending market — Aave's codebase deployed as an Ink-native
/// "whitelabel" market (bgd-labs/aave-address-book, `AaveV3InkWhitelabel`). Its
/// pool answers `getUserAccountData`, so one view call tells us whether a wallet
/// has supplied or borrowed here — a DeFi position, no indexer. A public address
/// and a plain view call, so the check runs from the browser as happily as from a
/// route: no secret, and no server needed to hold one.
export const INK_AAVE_POOL = "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA" as const;

/// Just the one view we need off the Aave pool. Everything it returns is
/// base-currency-denominated; collateral or debt above zero is a position.
export const aavePoolAbi = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

/** The raw reads behind the bar. `undefined` is "did not answer", never zero. */
export type ActivityReads = {
  mainnetTxns: number | undefined;
  sepoliaTxns: number | undefined;
  defi: boolean | undefined;
};

/** Which signal cleared the check, for the copy that names it. */
export type ActivityVia = "txns" | "defi";

/**
 * The verdict, from reads that may be partly missing.
 *
 * `null` means *nothing answered* — could not check, which is not the same as
 * failing, and the distinction is why every field here is `number | undefined`
 * rather than defaulted to zero. A wallet told it failed because an RPC was down
 * is being lied to about its own history.
 *
 * Order names the strongest real-usage signal first; passing is any-of.
 */
export function activityVerdict(r: ActivityReads): { pass: boolean; via: ActivityVia | null } | null {
  const answered =
    r.mainnetTxns !== undefined || r.sepoliaTxns !== undefined || r.defi !== undefined;
  if (!answered) return null;

  if (r.defi) return { pass: true, via: "defi" };
  const txnPass =
    (r.mainnetTxns ?? 0) >= MIN_INK_TXNS || (r.sepoliaTxns ?? 0) >= MIN_INK_TXNS;
  return { pass: txnPass, via: txnPass ? "txns" : null };
}

/**
 * Run the bar against one wallet, on whatever clients the caller has.
 *
 * Takes clients rather than making them, because the two callers need different
 * ones: the browser builds a throwaway client per chain with `http()` defaults,
 * while the route uses `serverClient` with its fallback transport, batching and
 * retry — the settings lib/server-rpc.ts exists to get right. Baking either choice
 * in here would force the other caller to do it wrong.
 *
 * Every read is individually `catch`ed to `undefined`, so one endpoint having a bad
 * minute degrades the verdict to "could not check" rather than rejecting a wallet
 * that has done nothing wrong.
 */
export async function readActivity(
  account: Address,
  clients: {
    mainnet: PublicClient<any, Chain> | undefined;
    sepolia: PublicClient<any, Chain> | undefined;
  },
): Promise<ActivityReads> {
  const [mainnetTxns, sepoliaTxns, defi] = await Promise.all([
    clients.mainnet
      ? clients.mainnet.getTransactionCount({ address: account }).catch(() => undefined)
      : Promise.resolve(undefined),
    clients.sepolia
      ? clients.sepolia.getTransactionCount({ address: account }).catch(() => undefined)
      : Promise.resolve(undefined),
    clients.mainnet
      ? clients.mainnet
          .readContract({
            address: INK_AAVE_POOL,
            abi: aavePoolAbi,
            functionName: "getUserAccountData",
            args: [account],
          })
          .then((d) => d[0] > 0n || d[1] > 0n)
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  return { mainnetTxns, sepoliaTxns, defi };
}
