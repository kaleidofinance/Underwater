import { NextResponse } from "next/server";
import type { Address } from "viem";
import { isAddress } from "viem";
import { factoryAbi, launchpadAbi, pairAbi, pointsAbi, routerAbi, waitlistAbi } from "@/lib/abis";
import { activityVerdict, readActivity } from "@/lib/activity";
import { ink, inkSepolia } from "@/lib/chains";
import { launchpadFor } from "@/lib/contracts";
import {
  REGISTERED_EVENT,
  SWAP_EVENT,
  TOKEN_CREATED_EVENT,
  TRADE_EVENT,
  type RegisteredArgs,
} from "@/lib/events";
import {
  NO_COUNTS,
  pointsFor,
  pointsFrom,
  pointsFromBlock,
  RATES_FALLBACK,
  type PointCounts,
  type Rates,
} from "@/lib/points";
import { cached, cacheHeaders, chainFrom, serverClient } from "@/lib/server-rpc";
import { waitlistFor } from "@/lib/waitlist-address";

/**
 * uwPoints for one address, and where that address ranks.
 *
 * A server route rather than a browser read, for three reasons that all point the
 * same way:
 *
 *  1. **It is a log scan, not a call.** Counting a wallet's trades means
 *     `eth_getLogs` over the chain's whole history in chunks. That is far too much
 *     to run per tab, and lib/server-rpc.ts exists for exactly this shape: read
 *     once, cache at the edge, let every visitor read the answer.
 *  2. **The rank needs everybody.** A position in a leaderboard cannot be computed
 *     from one wallet's data. The board is built here, once per window, and
 *     `/api/points?address=` reads a position out of it.
 *  3. **Valid referrals cost a read each.** The bar is the same one the register
 *     form's Verify button applies (lib/activity.ts), so scoring a wallet with
 *     forty referrals is forty nonce reads. Once per cache window for everyone is
 *     affordable; once per tab is not.
 *
 * **What this route is not.** It is not authoritative and must not be described as
 * such. It is arithmetic over public logs, and anyone can rerun it — that is the
 * point of deriving balances rather than storing them (see UnderwaterPoints.sol).
 * When uwPoints become $WATER the claim will go through a committed snapshot, the
 * way the plates allowlist already does, not through this number.
 */
export const runtime = "nodejs";
// Dynamic, not ISR — see the note in /api/head, and /api/eth-usd before it.
export const dynamic = "force-dynamic";

/**
 * How many blocks one `eth_getLogs` may cover.
 *
 * Public RPCs cap a log query, by block span or by result count or both, and the
 * cap is undocumented and inconsistent between providers. 50k blocks is ~14 hours
 * on Ink's one-second blocks and comfortably inside every cap we have met; the
 * chunker below halves on failure, so an endpoint with a stricter limit costs
 * retries rather than an error.
 */
const CHUNK = 50_000n;

/** Below this a chunk is not worth halving again — the endpoint is simply down. */
const MIN_CHUNK = 2_000n;

/**
 * Cache windows. Points move on the timescale of somebody making a transaction and
 * then looking at a page, so a minute is generous, and the board behind them is the
 * expensive thing.
 *
 * The board's window is far longer than one address's, because rebuilding it means
 * re-scoring every registrant's referrals. A rank that is ten minutes stale is a
 * rank that is right about everything except the last few registrations; a rank
 * that times out is no rank at all.
 */
const ADDRESS_MEMO_MS = 60_000;
const BOARD_MEMO_MS = 10 * 60_000;
const EDGE_S = 30;
const SWR_S = 300;

/** How many registrants the board will score. Above this, ranks are not offered. */
const BOARD_LIMIT = 2_000;

type Client = ReturnType<typeof serverClient>;

/**
 * Logs for one filter across the whole history, in chunks, halving on failure.
 *
 * Deliberately tolerant. A chunk that fails twice is skipped rather than thrown,
 * and the caller is told how many were lost — because the alternative is a page
 * that shows nothing when one range of one endpoint is unhappy, and a points total
 * that is short by a few trades is far better than no total at all. `partial` is
 * how the card knows to say so.
 */
async function scanLogs(
  client: Client,
  filter: Parameters<Client["getLogs"]>[0],
  from: bigint,
  to: bigint,
): Promise<{ logs: unknown[]; partial: boolean }> {
  const logs: unknown[] = [];
  let partial = false;
  let cursor = from;
  let span = CHUNK;

  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n;
    try {
      const batch = await client.getLogs({
        ...filter,
        fromBlock: cursor,
        toBlock: end,
      } as Parameters<Client["getLogs"]>[0]);
      logs.push(...batch);
      cursor = end + 1n;
      // Grow back toward the full chunk after a success, so one strict range does
      // not slow the rest of the scan to the reduced size for the whole history.
      if (span < CHUNK) span = span * 2n > CHUNK ? CHUNK : span * 2n;
    } catch {
      if (span > MIN_CHUNK) {
        span = span / 2n;
        continue;
      }
      // Give up on this range only, and move past it.
      partial = true;
      cursor = end + 1n;
      span = CHUNK;
    }
  }

  return { logs, partial };
}

/** Every pair the factory has made, so swaps can be counted across all of them. */
async function allPairs(client: Client, launchpad: Address): Promise<Address[]> {
  try {
    const router = (await client.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "router",
    })) as Address;
    const factory = (await client.readContract({
      address: router,
      abi: routerAbi,
      functionName: "factory",
    })) as Address;
    const n = (await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "allPairsLength",
    })) as bigint;

    const idx = Array.from({ length: Number(n) }, (_, i) => BigInt(i));
    const settled = await Promise.allSettled(
      idx.map((i) =>
        client.readContract({
          address: factory,
          abi: factoryAbi,
          functionName: "allPairs",
          args: [i],
        }),
      ),
    );
    return settled
      .map((r) => (r.status === "fulfilled" ? (r.value as Address) : null))
      .filter((a): a is Address => !!a);
  } catch {
    return [];
  }
}

/**
 * The rate card, from the chain if the contract is deployed here.
 *
 * Falls back to `RATES_FALLBACK` rather than to zeroes, and reports which it used,
 * because a chain without the points contract should still show a coherent card
 * labelled as indicative — zeroes would read as "you have earned nothing", which
 * is a different and false statement.
 */
async function readRates(
  client: Client,
  points: Address | null,
): Promise<{ rates: Rates; onChain: boolean; version: number }> {
  if (!points) return { rates: RATES_FALLBACK, onChain: false, version: 0 };
  try {
    const [card, version] = (await client.readContract({
      address: points,
      abi: pointsAbi,
      functionName: "rateCard",
    })) as [
      { register: bigint; referral: bigint; create: bigint; swap: bigint },
      bigint,
    ];
    return {
      rates: {
        register: card.register,
        referral: card.referral,
        create: card.create,
        swap: card.swap,
      },
      onChain: true,
      version: Number(version),
    };
  } catch {
    return { rates: RATES_FALLBACK, onChain: false, version: 0 };
  }
}

/** Coupons and hand grants for one address. Zero when no contract is deployed. */
async function readGranted(client: Client, points: Address | null, who: Address) {
  if (!points) return 0n;
  try {
    return (await client.readContract({
      address: points,
      abi: pointsAbi,
      functionName: "granted",
      args: [who],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/**
 * Everything the chain records about one address's earning, counted.
 *
 * Five scans, issued together. Each is filtered on an indexed field, so the RPC
 * does the selecting and the response is only this wallet's logs — a scan of the
 * whole history costs a handful of round trips rather than a download of every
 * trade ever made.
 *
 * The swap scan is the one with a subtlety worth stating: `Swap.to` is the
 * recipient, and the router sends intermediate hops to the *next pair* rather than
 * to the trader (see `_swap` in UnderwaterRouter.sol). So filtering on `to`
 * naturally counts one credit per swap transaction no matter how many hops it took,
 * which is the behaviour we want and is not a coincidence worth rediscovering later.
 */
async function countFor(
  client: Client,
  chainId: number,
  who: Address,
  opts: { waitlist: Address | null; launchpad: Address | null; pairs: Address[] },
): Promise<{ counts: PointCounts; referred: Address[]; partial: boolean }> {
  const from = pointsFromBlock(chainId);
  const to = await client.getBlockNumber();

  const [mine, brought, creates, curveTrades, poolSwaps] = await Promise.all([
    opts.waitlist
      ? scanLogs(client, { address: opts.waitlist, event: REGISTERED_EVENT, args: { who } }, from, to)
      : Promise.resolve({ logs: [], partial: false }),
    opts.waitlist
      ? scanLogs(
          client,
          { address: opts.waitlist, event: REGISTERED_EVENT, args: { referrer: who } },
          from,
          to,
        )
      : Promise.resolve({ logs: [], partial: false }),
    opts.launchpad
      ? scanLogs(
          client,
          { address: opts.launchpad, event: TOKEN_CREATED_EVENT, args: { creator: who } },
          from,
          to,
        )
      : Promise.resolve({ logs: [], partial: false }),
    opts.launchpad
      ? scanLogs(client, { address: opts.launchpad, event: TRADE_EVENT, args: { trader: who } }, from, to)
      : Promise.resolve({ logs: [], partial: false }),
    opts.pairs.length
      ? scanLogs(client, { address: opts.pairs, event: SWAP_EVENT, args: { to: who } }, from, to)
      : Promise.resolve({ logs: [], partial: false }),
  ]);

  const referred = brought.logs
    .map((l) => ((l as { args?: RegisteredArgs }).args?.who ?? null))
    .filter((a): a is Address => !!a);

  return {
    counts: {
      registered: mine.logs.length > 0,
      referrals: referred.length,
      // Filled in by the caller — scoring these is a read per address and the
      // board path scores them in bulk, so it is not done here.
      validReferrals: 0,
      creates: creates.logs.length,
      trades: curveTrades.logs.length + poolSwaps.logs.length,
    },
    referred,
    partial:
      mine.partial ||
      brought.partial ||
      creates.partial ||
      curveTrades.partial ||
      poolSwaps.partial,
  };
}

/**
 * How many of `addresses` clear the activity bar.
 *
 * The bar is `lib/activity.ts` — the same one the register form's Verify button
 * applies, which is the whole reason that module exists. A referral of a wallet
 * that has never used Ink is worth nothing, so a farm of fresh wallets earns
 * nothing, which is what ALLOWLIST.md already says about the referral board.
 *
 * A wallet whose reads all fail counts as **not valid**, and that asymmetry is
 * deliberate: the failure mode of guessing "valid" is paying points for wallets
 * nobody verified, which is the exact thing the bar exists to prevent. The card
 * says the count is a lower bound rather than pretending otherwise.
 */
async function countValid(addresses: Address[]): Promise<number> {
  if (addresses.length === 0) return 0;

  const mainnet = serverClient(ink);
  const sepolia = serverClient(inkSepolia);

  const verdicts = await Promise.all(
    addresses.map((a) =>
      readActivity(a, { mainnet, sepolia })
        .then((r) => activityVerdict(r)?.pass === true)
        .catch(() => false),
    ),
  );

  return verdicts.filter(Boolean).length;
}

/**
 * Every registrant's total, sorted — the board a rank is read out of.
 *
 * The expensive thing in this file by a wide margin, hence its own long cache
 * window. It walks the waitlist's registrant list and scores each one, which is
 * where `BOARD_LIMIT` earns its keep: past a couple of thousand registrants this
 * stops being a thing a request can do at all, and the honest response is to serve
 * the balance with no rank rather than to time out or to invent one. The card
 * handles a missing rank; it cannot handle a wrong one.
 */
async function buildBoard(
  client: Client,
  chainId: number,
  opts: { waitlist: Address | null; launchpad: Address | null; pairs: Address[] },
  rates: Rates,
  points: Address | null,
): Promise<{ order: string[]; capped: boolean } | null> {
  if (!opts.waitlist) return null;

  const total = (await client.readContract({
    address: opts.waitlist,
    abi: waitlistAbi,
    functionName: "count",
  })) as bigint;

  if (total === 0n) return { order: [], capped: false };
  const capped = total > BigInt(BOARD_LIMIT);
  if (capped) return { order: [], capped: true };

  const registrants = (await client.readContract({
    address: opts.waitlist,
    abi: waitlistAbi,
    functionName: "all",
  })) as Address[];

  const scored = await Promise.all(
    registrants.map(async (who) => {
      try {
        const { counts, referred } = await countFor(client, chainId, who, opts);
        const [validReferrals, granted] = await Promise.all([
          countValid(referred),
          readGranted(client, points, who),
        ]);
        const { total: t } = pointsFrom({ ...counts, validReferrals }, rates, granted);
        return { who: who.toLowerCase(), total: t };
      } catch {
        return { who: who.toLowerCase(), total: 0n };
      }
    }),
  );

  // Ties broken by arrival order, which is the order `all()` returns and the only
  // tiebreak the chain gives us for free. A stable sort keeps it.
  scored.sort((a, b) => (a.total === b.total ? 0 : b.total > a.total ? 1 : -1));

  return { order: scored.map((s) => s.who), capped: false };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const chain = chainFrom(url);
  if (!chain) {
    return NextResponse.json({ error: "unknown chain" }, { status: 400 });
  }

  const raw = url.searchParams.get("address");
  if (!raw || !isAddress(raw)) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }
  const who = raw as Address;

  const client = serverClient(chain);
  const waitlist = waitlistFor(chain.id);
  const launchpad = launchpadFor(chain.id);
  const points = pointsFor(chain.id);

  if (!waitlist && !launchpad) {
    return NextResponse.json(
      { error: "nothing deployed on this chain" },
      { status: 404 },
    );
  }

  try {
    const { value } = await cached(
      `points:${chain.id}:${who.toLowerCase()}`,
      ADDRESS_MEMO_MS,
      async () => {
        const [{ rates, onChain, version }, pairs] = await Promise.all([
          readRates(client, points),
          launchpad ? allPairs(client, launchpad) : Promise.resolve([]),
        ]);

        const opts = { waitlist, launchpad, pairs };
        const { counts, referred, partial } = await countFor(client, chain.id, who, opts);
        const [validReferrals, granted] = await Promise.all([
          countValid(referred),
          readGranted(client, points, who),
        ]);

        const full = { ...counts, validReferrals };
        const breakdown = pointsFrom(full, rates, granted);

        // The board is its own cache entry: one build serves every address that
        // asks in the window, which is the only way a rank is affordable.
        const board = await cached(
          `points-board:${chain.id}:${version}`,
          BOARD_MEMO_MS,
          () => buildBoard(client, chain.id, opts, rates, points),
        )
          .then((r) => r.value)
          .catch(() => null);

        const at = board?.order.indexOf(who.toLowerCase()) ?? -1;

        return {
          address: who,
          chainId: chain.id,
          counts: full,
          points: {
            registration: breakdown.registration.toString(),
            referral: breakdown.referral.toString(),
            creation: breakdown.creation.toString(),
            trading: breakdown.trading.toString(),
            granted: breakdown.granted.toString(),
            total: breakdown.total.toString(),
          },
          rates: {
            register: rates.register.toString(),
            referral: rates.referral.toString(),
            create: rates.create.toString(),
            swap: rates.swap.toString(),
          },
          /// False when no points contract is deployed here, so the card can say
          /// the rates are indicative rather than quoting them as settled.
          ratesOnChain: onChain,
          rank: at >= 0 ? at + 1 : null,
          rankOf: board && !board.capped ? board.order.length : null,
          /// True when a log range could not be read, so a total may be short.
          partial,
        };
      },
    );

    return NextResponse.json(value, { headers: cacheHeaders(EDGE_S, SWR_S) });
  } catch (err) {
    console.error("[points] scan failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not read points" }, { status: 502 });
  }
}
