import { getAddress, type Address } from "viem";
import { CURVE } from "@/lib/contracts";
import type { Listing, MarketState, Pool } from "@/lib/market";
import { MARKET_LIMIT } from "@/lib/market";
import type { Opens } from "@/lib/scans";
import { big, WireError } from "@/lib/wire";

/**
 * Reading the market out of the Ponder indexer instead of off the chain.
 *
 * The two routes this serves — `/api/market` and `/api/volume` — exist because a market
 * page is the same answer for every visitor and deriving it per tab against a public RPC
 * does not scale. They solve that by caching hard. What they cannot solve by caching is
 * that the answer itself is *assembled from* RPC: 400 contract reads for a hundred
 * listings, and a chunked `eth_getLogs` walk backwards through history that only ever
 * covers as much as it managed before the clock ran out. Both are correct and both are
 * bounded by the endpoint.
 *
 * The indexer has already done that walk, once, into Postgres. So where it is available
 * these adapters answer the same questions as a `SELECT`, and where it is not the routes
 * fall back to what they do today. That fallback is the whole design constraint: every
 * function here returns `undefined` rather than throwing, and it does so for a missing
 * variable, an unserved chain, an unfinished backfill, a timeout, a non-2xx, a wrong
 * launchpad, and a payload that does not decode. A market page that renders from the
 * chain is the status quo; a market page that renders half a market because a service
 * was mid-backfill is a regression.
 *
 * What is deliberately *not* here is any fee policy. The adapters return what the
 * indexer counted — ETH moved, the pool's share of it, and the fees three contracts
 * logged — and `/api/volume` derives the fourth leg and the total from those exactly as
 * it does from a scan, because whether the DEX fee switch is on is pair state that lives
 * on the chain and not in any table. See `POOL_CUT_BPS` and `feesOf` in that route.
 */

/**
 * Where the indexer is, or nothing.
 *
 * Server-only and unprefixed on purpose. Nothing in the browser should be able to reach
 * this: the routes in front of it are what carry the CDN cache headers, the shared memo
 * and the wire encoding, and a client talking to the indexer directly would bypass all
 * three and put a database-backed service behind a per-tab poll. Unset is a supported
 * state, not a misconfiguration — it is what every deployment looks like until an indexer
 * is pointed at it, and it means "use the chain".
 */
const INDEXER_URL = process.env.INDEXER_URL?.trim().replace(/\/+$/, "") || undefined;

/**
 * How long a fetch is allowed, and how long a verdict about the service is held.
 *
 * The timeout is short because the fallback is not an error page, it is the RPC path —
 * so waiting is strictly worse than giving up, and the budget that matters is the
 * route's own, which is already spending it on reads it may still have to make.
 *
 * `UP_MS` is a re-probe interval rather than a cache lifetime: the probe carries the
 * indexed head, which moves every block, and 15 seconds of staleness in a figure the
 * route only reports as a range is not worth a request per read. `DOWN_MS` is longer
 * because the cost of being wrong runs the other way — a service that is down should not
 * be asked three questions on every request until it comes back.
 */
const FETCH_MS = 2_000;
const UP_MS = 15_000;
const DOWN_MS = 30_000;

/** What the indexer says about one chain, once it has said it can serve it at all. */
type Probe = {
  /** The launchpad's deploy block — the floor of every figure below. */
  startBlock: bigint;
  /** The block it has indexed up to. Ponder's own, not a column of ours. */
  head: bigint;
};

async function json(path: string): Promise<unknown> {
  const res = await fetch(`${INDEXER_URL}${path}`, {
    // No CDN or fetch cache in front of this. The route above it is the cache layer, and
    // a second one here would give the memo a stale head and a stale readiness verdict
    // that outlive the ones this module is explicitly timing.
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new WireError(`${path}: ${res.status}`);
  return res.json();
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * An address, checksummed.
 *
 * Checksummed and not lowercased, which is the one thing about this module that has to
 * match the RPC path byte for byte rather than merely mean the same. viem returns
 * checksummed addresses from a contract read, so that is what `Listing.token` has always
 * been on the wire, and a `===` somewhere against a checksummed address would start
 * missing if this path handed back the lowercase form the tables store. `Day.opens` is
 * the deliberate exception and is keyed lowercase at both ends — see `opensOf`.
 */
function address(value: unknown, what: string): Address {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return getAddress(value);
  }
  throw new WireError(`${what}: expected an address`);
}

/**
 * A block number off one of *Ponder's* endpoints, which send it as a JSON number.
 *
 * `big` refuses a number on purpose, and that is right for every other field here: our
 * own `/market`, `/volume` and `/chains` send every integer as a decimal string, so a
 * number arriving where one of those was promised means something upstream put a wei
 * figure through a double. `/status` is not one of our routes and never made that promise
 * — its `block.number` is a plain integer — so the conversion is explicit in one place
 * rather than loosened for everything.
 *
 * Checked rather than converted blind: `BigInt` throws on a fraction and quietly accepts
 * a value that already lost precision, and neither is a failure worth passing on.
 */
function blockOf(value: unknown, what: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new WireError(`${what}: expected a block number`);
}

/**
 * Whether the indexer can be trusted with this chain right now.
 *
 * Four questions, and each one rules out a failure that the others let through:
 *
 * `/chains` says which chains this process was configured for. Without it an unserved
 * chain is indistinguishable from a served one with no launches, because both are zero
 * rows — and answering the market page with the second when the truth is the first shows
 * a visitor an empty market on a chain that has launches.
 *
 * The launchpad on that payload is checked against the app's own. An indexer aimed at a
 * different deployment of the same contract on the same chain id — a redeploy, a variable
 * copied from the wrong environment — returns rows that are internally consistent and
 * describe a market nobody is looking at. It is the only failure here that every other
 * check passes cleanly.
 *
 * `/ready` is Ponder's: 200 once every chain has finished its historical backfill, 503
 * while one is still working. This is the gate that matters most and it is worth being
 * precise about why. A half-backfilled indexer does not report *nothing*, it reports
 * totals that are too small — a day of volume where there were three, fees missing the
 * launches it has not reached. The scan is honest about the same partial state, because
 * it says how far back it got and the card reads "so far" off it. A `SELECT` cannot say
 * that. So until the backfill is done, the chain is the better source.
 *
 * `/status` is also Ponder's, and is where the indexed head comes from. The routes report
 * a block range beside their figures, and the honest end of it is what the indexer has
 * caught up to, not the last block that happened to contain a trade — a quiet market
 * would make the second look like indexing had stalled.
 */
type Verdict = { at: number; probe: Probe | undefined };
const verdicts = new Map<number, Verdict>();
const inflight = new Map<number, Promise<Probe | undefined>>();

async function ask(chainId: number, launchpad: Address): Promise<Probe | undefined> {
  const [chains, ready, status] = await Promise.all([
    json("/chains"),
    fetch(`${INDEXER_URL}/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_MS),
    }),
    json("/status"),
  ]);

  if (!ready.ok) return undefined;

  const listed = record(chains, "chains").chains;
  if (!Array.isArray(listed)) throw new WireError("chains: expected an array");

  const mine = listed
    .map((row) => record(row, "chains[]"))
    .find((row) => Number(row.chainId) === chainId);
  if (!mine) return undefined;

  // A different deployment at the same chain id is a different market. Fall back rather
  // than serve it: the rows are not wrong, they are about something else.
  if (address(mine.launchpad, "chains[].launchpad") !== getAddress(launchpad)) {
    console.warn(
      `[indexer] chain ${chainId} indexes ${mine.launchpad}, app is on ${launchpad} — using RPC`,
    );
    return undefined;
  }

  // Ponder keys `/status` by chain *name*, with the id inside. The name is its own and
  // we do not have it here, so the id is what this matches on.
  const head = Object.values(record(status, "status"))
    .map((entry) => record(entry, "status[]"))
    .find((entry) => Number(entry.id) === chainId);
  if (!head) return undefined;

  return {
    startBlock: big(mine.startBlock),
    head: blockOf(record(head.block, "status[].block").number, "status[].block.number"),
  };
}

async function probeFor(chainId: number, launchpad: Address): Promise<Probe | undefined> {
  if (!INDEXER_URL) return undefined;

  const held = verdicts.get(chainId);
  if (held && Date.now() - held.at < (held.probe ? UP_MS : DOWN_MS)) return held.probe;

  // One probe per chain in flight, shared. Without this the first read after a verdict
  // expires fans every concurrent request out into its own three requests.
  const already = inflight.get(chainId);
  if (already) return already;

  const run = ask(chainId, launchpad)
    .catch((err) => {
      console.warn(
        `[indexer] chain ${chainId} probe failed:`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    })
    .then((probe) => {
      verdicts.set(chainId, { at: Date.now(), probe });
      inflight.delete(chainId);
      return probe;
    });

  inflight.set(chainId, run);
  return run;
}

/* ---------------------------------------------------------------------------
 * The market list.
 * ------------------------------------------------------------------------- */

/**
 * `tokensSold` is not a column, and it does not need to be.
 *
 * The launchpad writes `tokenReserve` and `tokensSold` as exact mirrors of each other in
 * every place either one moves: `create()` sets them to `INITIAL_TOKEN_RESERVE` and zero
 * (UnderwaterLaunchpad.sol:250), a sell adds to one and subtracts from the other
 * (:321, :323), a buy does the reverse (:387, :389), and graduation writes neither. So
 * their sum is `INITIAL_TOKEN_RESERVE` for the life of the pool, by induction — and that
 * constant is `1_000_000_000e18` (:50), the same number as `TOTAL_SUPPLY` (:37), which
 * the app already holds as `CURVE.totalSupply`.
 *
 * Derived rather than stored deliberately: a column would be a second copy of a number
 * that is already on the row, and the identity is enforced by the contract rather than by
 * the indexer remembering to keep them in step.
 */
const soldOf = (tokenReserve: bigint) => CURVE.totalSupply - tokenReserve;

function listingOf(raw: unknown): Listing {
  const row = record(raw, "listing");

  const tokenReserve = big(row.tokenReserve);
  const graduated = row.graduated === true;

  const pool: Pool = {
    ethReserve: big(row.ethReserve),
    tokenReserve,
    realEthRaised: big(row.realEthRaised),
    tokensSold: soldOf(tokenReserve),
    creator: address(row.creator, "listing.creator"),
    createdAt: Number(row.createdAt) || 0,
    graduated,
    // A row exists because `TokenCreated` fired for it, which is the same fact the
    // getter's `exists` flag records.
    exists: true,
  };

  return {
    token: address(row.address, "listing.address"),
    name: typeof row.name === "string" ? row.name : "—",
    symbol: typeof row.symbol === "string" ? row.symbol : "—",
    metadataURI: typeof row.metadataUri === "string" ? row.metadataUri : "",
    pool,
    // Already the pair's price on a graduated token: the `Graduated` handler prices it
    // off the seeded liquidity and every `Sync` reprices it, which is exactly what
    // `priceSource` picks between on the RPC path. So is the cap.
    priceE18: big(row.priceE18),
    marketCap: big(row.marketCapWei),
    progress: Number(row.progressBps) || 0,
    fromPool: graduated && typeof row.pair === "string",
  };
}

/**
 * The newest launches on a chain, already priced — the whole of `MarketState`.
 *
 * One request replacing `MARKET_LIMIT × PER_LISTING` contract calls, and the figures are
 * the same ones: the indexer vendors `lib/curve.ts`, so `priceE18`, `marketCapWei` and
 * `progressBps` come out of the same three pure functions the route calls, on reserves
 * the contract emitted rather than reserves read back afterwards.
 *
 * `tokenCount` is a `count(*)` where the route reads the launchpad's counter. Both are
 * one row per launch, so they agree — and the profile page's "older launches are outside
 * this window" notice reads off it either way.
 */
export async function indexedMarket(
  chainId: number,
  launchpad: Address,
): Promise<MarketState | undefined> {
  const probe = await probeFor(chainId, launchpad);
  if (!probe) return undefined;

  try {
    const body = record(
      await json(`/market?chain=${chainId}&limit=${MARKET_LIMIT}&sort=new`),
      "market",
    );
    if (!Array.isArray(body.listings)) {
      throw new WireError("market.listings: expected an array");
    }

    return {
      chainId,
      launchpad,
      tokenCount: big(body.tokenCount),
      listings: body.listings.map(listingOf),
    };
  } catch (err) {
    console.warn(
      `[indexer] chain ${chainId} market unavailable, using RPC:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/* ---------------------------------------------------------------------------
 * Volume and revenue.
 * ------------------------------------------------------------------------- */

/**
 * One window, counted — the facts, with no fee policy applied.
 *
 * Named to line up field-for-field with `Part` in /api/volume so that route can hand
 * this to its own `feesOf` unchanged: `poolEth` is the share of `eth` that moved on a
 * pair, `curveFees` is summed `Trade.feeAmount`, `gradFees` is summed
 * `Graduated.protocolFee`.
 *
 * `creationFees` is the one field with no counterpart there, and it is the reason this
 * split is worth having. The scan cannot window a counter, so it values every launch at
 * *today's* `creationFee` — which is exact only while the fee has never changed, and
 * silently wrong afterwards in both directions. These rows were each written with the fee
 * in force at that launch's own block, so this is a sum rather than a product.
 */
export type IndexedWindow = {
  eth: bigint;
  poolEth: bigint;
  trades: number;
  curveFees: bigint;
  gradFees: bigint;
  creationFees: bigint;
};

/** Everything /api/volume needs from the indexer to assemble a `Volume`. */
export type IndexedVolume = {
  all: IndexedWindow;
  /** The rolling window, plus what each launch on the page cost when it opened. */
  day: IndexedWindow & { seconds: number; opens: Opens };
  /** The launchpad's deploy block and the indexed head — the range these cover. */
  startBlock: bigint;
  head: bigint;
};

function windowOf(raw: unknown, what: string): IndexedWindow {
  const w = record(raw, what);
  const fees = record(w.fees, `${what}.fees`);
  return {
    eth: big(w.eth),
    poolEth: big(w.poolEth),
    trades: Number(w.trades) || 0,
    curveFees: big(fees.trade),
    gradFees: big(fees.graduation),
    creationFees: big(fees.creation),
  };
}

/**
 * What each launch cost when the window opened, keyed by lowercased address.
 *
 * Strict about the key, as `decodeOpens` in lib/scans.ts is and for the same reason: the
 * consumer looks a listing's own address up in here, so a key in the wrong case is a
 * lookup that silently misses and a launch that renders no change at all.
 */
function opensOf(raw: unknown): Opens {
  const w = record(raw, "day.opens");
  const out: Opens = {};
  for (const [key, value] of Object.entries(w)) {
    if (!/^0x[0-9a-f]{40}$/.test(key)) {
      throw new WireError(`day.opens: ${key} is not a lowercased address`);
    }
    out[key] = big(value);
  }
  return out;
}

/**
 * Volume, revenue and per-launch opens, all time and over a real rolling day.
 *
 * The day here is a genuine 86,400 seconds on every read, including the first one after a
 * deploy — where the scan's window is however much settled history that instance has
 * managed to reach, and its `seconds` says so. Both are honest; only one of them is the
 * number the card is labelled with.
 *
 * All time means all time for the same reason. The scan's cumulative total is "since this
 * instance started, plus as far back as it has crawled", which is why `Volume.allTime`
 * exists as a flag at all; a caller on this path can set it true.
 */
export async function indexedVolume(
  chainId: number,
  launchpad: Address,
  seconds: number,
): Promise<IndexedVolume | undefined> {
  const probe = await probeFor(chainId, launchpad);
  if (!probe) return undefined;

  try {
    const body = record(
      await json(
        `/volume?chain=${chainId}&seconds=${seconds}&limit=${MARKET_LIMIT}`,
      ),
      "volume",
    );
    const day = record(body.day, "volume.day");

    return {
      all: windowOf(body.all, "volume.all"),
      day: {
        ...windowOf(day, "volume.day"),
        // Echoed rather than trusted: the route asked for a window and the indexer caps
        // it, so this is what was actually measured.
        seconds: Number(day.seconds) || seconds,
        opens: opensOf(day.opens),
      },
      startBlock: probe.startBlock,
      head: probe.head,
    };
  } catch (err) {
    console.warn(
      `[indexer] chain ${chainId} volume unavailable, using RPC:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}
