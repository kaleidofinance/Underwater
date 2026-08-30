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
 * How long a wallet's verdict is reused, in milliseconds.
 *
 * A pass is kept forever and only a failure expires, which is not a shortcut but the
 * shape of the bar: the txns half is a nonce, which only goes up, so a wallet that has
 * cleared it cannot stop having cleared it. A failure is the answer that can go out of
 * date, so that is the one worth asking again.
 */
export const ACTIVITY_MEMO_MS = 10 * 60_000;

/** Wallets checked concurrently by default. Each is three reads, so this is twelve. */
const LANES = 4;

type Verdict = { pass: boolean; at: number };

/**
 * Every verdict this instance has reached, and when.
 *
 * Module scope and shared by every caller, which is the point of it living here rather
 * than in a route: the leaderboard verifies a chain's whole referral set, one wallet's
 * history verifies the handful of referrals on its page, and both must agree about the
 * same wallet — a row reading "referral cleared, +1,000" beside a total that did not pay
 * for it is the kind of disagreement nobody can explain.
 *
 * Not `cached`, because the bound below has to know what is *already* known before it
 * decides what to spend its clock on, and a memo can only answer that by doing the work.
 * Kept in check by {@link pruneVerdicts}.
 */
const verdicts = new Map<string, Verdict>();

export type ActivityClients = {
  mainnet: PublicClient<any, Chain> | undefined;
  sepolia: PublicClient<any, Chain> | undefined;
};

/**
 * Which of `addresses` clear the bar, and how many are still unasked.
 *
 * Bounded twice over — by `max` wallets and by `deadline` — because this is the one part
 * of scoring that cannot be answered from a log: it is a nonce and a lending position, on
 * two other chains, and it is asked once per *referred* wallet. Bounded rather than
 * skipped because it converges the way a backfill does: verdicts are kept, so each read
 * gets through another batch and `behind` falls to zero.
 *
 * A wallet whose reads all fail counts as **not valid**, and that asymmetry is
 * deliberate: the failure mode of guessing "valid" is paying points for wallets nobody
 * verified, which is the exact thing the bar exists to prevent. It is also why an
 * unreadable verdict is not recorded at all — "could not check" is asked again next read
 * rather than frozen in as a failure.
 *
 * `behind` counts addresses that have never produced a verdict, which is the honest input
 * to a "still counting" flag: their referrers' totals are low until they do. A *stale*
 * failure is not behind — it is a real answer that may be a few minutes old, and counting
 * it would leave the flag stuck on for any set bigger than one read's budget.
 */
export async function verifyActivity(
  addresses: readonly string[],
  clients: ActivityClients,
  deadline: number,
  opts: { max: number; lanes?: number },
): Promise<{ pass: Set<string>; behind: number }> {
  const pass = new Set<string>();
  const never: string[] = [];
  const stale: string[] = [];
  const now = Date.now();
  const keys = addresses.map((a) => a.toLowerCase());

  for (const who of keys) {
    const v = verdicts.get(who);
    // A pass is permanent — see ACTIVITY_MEMO_MS. Re-asking would spend the budget
    // re-proving what is already settled.
    if (v?.pass) {
      pass.add(who);
      continue;
    }
    if (!v) never.push(who);
    else if (now - v.at >= ACTIVITY_MEMO_MS) stale.push(who);
  }

  // Never-asked first: an unknown wallet is costing its referrer points right now,
  // whereas a re-ask is only refreshing an answer we already have.
  const todo = [...never, ...stale].slice(0, opts.max);
  const lanes = opts.lanes ?? LANES;

  for (let i = 0; i < todo.length && Date.now() < deadline; i += lanes) {
    const batch = todo.slice(i, i + lanes);
    const got = await Promise.all(
      batch.map((who) =>
        readActivity(who as Address, clients)
          .then(activityVerdict)
          .catch(() => null),
      ),
    );
    const stamp = Date.now();
    batch.forEach((who, j) => {
      const v = got[j];
      if (!v) return;
      verdicts.set(who, { pass: v.pass, at: stamp });
      if (v.pass) pass.add(who);
    });
  }

  // Counted from the map rather than from what was attempted, so a wallet whose reads
  // came back empty is still behind — `activityVerdict` returning null records nothing
  // and is asked again next read.
  let behind = 0;
  for (const who of keys) if (!verdicts.has(who)) behind++;
  return { pass, behind };
}

/**
 * Forget every verdict outside `keep`.
 *
 * The map's only bound, and it belongs to the caller that knows the full set: an address
 * nobody referred cannot affect any total, so keeping it is a leak. Callers holding a
 * *subset* — one wallet's referrals — must not call this, or they would evict the board's
 * work every time somebody opened their profile.
 */
export function pruneVerdicts(keep: Iterable<string>) {
  const set = new Set<string>();
  for (const who of keep) set.add(who.toLowerCase());
  for (const who of verdicts.keys()) if (!set.has(who)) verdicts.delete(who);
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
