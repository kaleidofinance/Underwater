import { ponder } from "ponder:registry";
import type { Context } from "ponder:registry";
import { account, pair, pointGrant } from "ponder:schema";
import { type Address, zeroAddress } from "viem";
import { launchpadAbi } from "../abis/generated";
import { configuredNetworks } from "../networks";

/**
 * The uwPoints side of the index — the counts a balance is priced from.
 *
 * The five earning streams live in four handlers across three files, because they are
 * emitted by three different contracts: `Registered` twice over from the waitlist,
 * `TokenCreated` and `Trade` from the launchpad, `Swap` from a pair. This file holds the
 * two writers they all go through, plus the points contract's own two events.
 *
 * What it deliberately does not hold is a balance. `UnderwaterPoints` stores a rate card
 * and a `granted` mapping and nothing else; a balance is `rates × counts + granted`,
 * recomputed on every read, so moving a rate re-prices every wallet's whole history. An
 * indexed balance would be a second answer to a question that has one, and it would be
 * wrong from the moment the owner touched a rate. The counts are indexed; the rates are
 * read from the chain at request time, exactly as the app does today.
 */

type Db = Context["db"];

/**
 * A count to add. Every field optional, and absent means zero rather than unchanged —
 * the two coincide here because nothing in this system ever decrements.
 */
type Delta = {
  referrals?: number;
  creates?: number;
  trades?: number;
  granted?: bigint;
};

/**
 * Add to a wallet's counts, creating the row if this is the first thing it has done.
 *
 * An upsert rather than a find-then-write because the account row has no creation event:
 * a wallet enters this table at whichever of five unrelated logs mentions it first, and
 * on a chain with no waitlist (Robinhood) that is a trade. The insert branch therefore
 * has to supply the waitlist columns as "not registered", and `enrol` fills them in
 * later if a registration ever arrives — the two writers are deliberately independent so
 * neither has to know whether the other ran.
 */
export async function credit(db: Db, chainId: number, who: Address, delta: Delta) {
  const referrals = delta.referrals ?? 0;
  const creates = delta.creates ?? 0;
  const trades = delta.trades ?? 0;
  const granted = delta.granted ?? 0n;

  await db
    .insert(account)
    .values({
      chainId,
      address: who,
      registered: false,
      position: null,
      registeredAt: null,
      referrer: null,
      referrals,
      creates,
      trades,
      granted,
    })
    .onConflictDoUpdate((row) => ({
      referrals: row.referrals + referrals,
      creates: row.creates + creates,
      trades: row.trades + trades,
      granted: row.granted + granted,
    }));
}

/**
 * Record that a wallet registered, without disturbing what it has already earned.
 *
 * The mirror image of `credit`: the conflict branch sets only the waitlist columns, so a
 * wallet that traded before it registered keeps its trade count. `referrer` is stored as
 * null for the zero address, because the event uses `address(0)` for "no referrer" and a
 * column that says null means the same thing in a language Postgres can index on.
 */
export async function enrol(
  db: Db,
  chainId: number,
  who: Address,
  args: { position: bigint; at: number; referrer: Address | null },
) {
  const enrolled = {
    registered: true,
    position: args.position,
    registeredAt: args.at,
    referrer: args.referrer,
  };

  await db
    .insert(account)
    .values({
      chainId,
      address: who,
      ...enrolled,
      referrals: 0,
      creates: 0,
      trades: 0,
      granted: 0n,
    })
    .onConflictDoUpdate(() => enrolled);
}

/**
 * The addresses that are contracts rather than traders, per chain.
 *
 * `Pair:Swap` credits `to`, and on a sell through the router `to` is the router itself —
 * it receives the WETH leg before unwrapping it — while on a multi-hop it is the next
 * pair in the path. Neither is a wallet, and crediting them would build one enormous
 * account row that outranks every user on the leaderboard. The app's `allVenues` excludes
 * the same set for the same reason (web/app/api/points/route.ts).
 *
 * The launchpad comes out of the configuration and the router from one read against it,
 * memoised for the process because `RouterUpdated` exists but firing it is an owner
 * action that has never happened; a stale router here would start crediting the router as
 * a trader, which is visible immediately in the leaderboard rather than silent.
 *
 * The DEX factory is in the app's set and not in this one. It can never be a swap
 * recipient — no code path sends output to it — so including it would mean vendoring a
 * third ABI to defend against nothing. Pairs are checked against the `pair` table
 * instead of the factory's `allPairs()`, which is both cheaper and a closer answer: the
 * only pairs this process indexes are the ones a launch graduated into.
 */
const infraCache = new Map<number, Set<string>>();

async function infraOf(context: Pick<Context, "chain" | "client">) {
  const chainId = context.chain.id;
  const held = infraCache.get(chainId);
  if (held) return held;

  const launchpad = configuredNetworks().find((c) => c.id === chainId)?.launchpad;
  const infra = new Set<string>();

  if (launchpad) {
    infra.add(launchpad.toLowerCase());
    try {
      const router = await context.client.readContract({
        address: launchpad,
        abi: launchpadAbi,
        functionName: "router",
      });
      infra.add(router.toLowerCase());
    } catch {
      // A launchpad with no router set yet reverts or returns nothing. Not fatal and not
      // cached wrongly: the set is memoised either way, but a launchpad without a router
      // has no graduated pairs, so there are no swaps to misattribute in the first place.
    }
  }

  infraCache.set(chainId, infra);
  return infra;
}

/**
 * Whether a `Swap` recipient should be credited as a trader.
 *
 * Three ways to fail: the zero address (a burn), one of the protocol's own contracts, or
 * another pair — which is a multi-hop leg, and the trader at the end of that path is
 * credited by the last pair in it.
 */
export async function isTrader(
  context: Pick<Context, "chain" | "client" | "db">,
  who: Address,
) {
  if (who === zeroAddress) return false;
  const infra = await infraOf(context);
  if (infra.has(who.toLowerCase())) return false;
  const hop = await context.db.find(pair, { chainId: context.chain.id, address: who });
  return hop === null;
}

/**
 * A coupon redeemed.
 *
 * `points` is a `uint64` in the event and `granted` is a `uint256` in the contract, which
 * is the same widening the contract does when it adds them — so the sum of these rows
 * reproduces `granted[who]` exactly. That equality is what lets the account row hold a
 * total the contract never emitted: grants are cumulative and never decremented, so a
 * sum over history and a mapping read are the same number, and `/points` checks them
 * against each other rather than assuming it.
 *
 * The code itself is never on-chain — only its hash — so the row can say a coupon was
 * redeemed and not which one in any human sense. That is the contract's design and not a
 * gap here.
 */
ponder.on("Points:Redeemed", async ({ event, context }) => {
  const chainId = context.chain.id;
  const amount = BigInt(event.args.points);

  await context.db.insert(pointGrant).values({
    id: `${chainId}-${event.block.number}-${event.log.logIndex}`,
    chainId,
    who: event.args.who,
    kind: "coupon",
    amount,
    codeHash: event.args.codeHash,
    reason: null,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
  });

  await credit(context.db, chainId, event.args.who, { granted: amount });
});

/**
 * Points awarded directly by the owner.
 *
 * `reason` is free text the owner wrote and it is shown to the wallet that received the
 * grant, so it is stored as it arrived rather than normalised — an empty string is a
 * grant with no stated reason, which is different from a coupon, where there is no reason
 * field to leave empty.
 */
ponder.on("Points:Granted", async ({ event, context }) => {
  const chainId = context.chain.id;
  const amount = event.args.points;

  await context.db.insert(pointGrant).values({
    id: `${chainId}-${event.block.number}-${event.log.logIndex}`,
    chainId,
    who: event.args.who,
    kind: "grant",
    amount,
    codeHash: null,
    reason: event.args.reason,
    timestamp: Number(event.block.timestamp),
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
  });

  await credit(context.db, chainId, event.args.who, { granted: amount });
});
