import type { Address } from "viem";
import { big, WireError } from "./wire";

/**
 * The market's shapes, and the one place they cross the server/client line.
 *
 * These lived in lib/hooks.ts and lib/dex.ts, which are both `"use client"` — and
 * a route handler cannot import from one of those: Next compiles a client module
 * into a reference, so `decodePool` reached from the server is a proxy rather than
 * a function. Nothing here is a hook and nothing here touches the DOM, so it moves
 * to a module with no directive and both sides import it. hooks.ts and dex.ts
 * re-export the types they used to own, so no call site changes.
 *
 * The pure derivations stay in lib/curve.ts. What is here is the decoding: turning
 * a Solidity tuple into a `Pool`, deciding which reserves a token is priced off,
 * and turning `/api/market`'s JSON back into `bigint`s.
 */

const ZERO = "0x0000000000000000000000000000000000000000";

/** Reads a contract-returned address, treating the zero address as absent. */
export function present(value: unknown): Address | undefined {
  return typeof value === "string" && value !== ZERO
    ? (value as Address)
    : undefined;
}

/** Decoded form of the launchpad's `pools(address)` getter. */
export type Pool = {
  ethReserve: bigint;
  tokenReserve: bigint;
  realEthRaised: bigint;
  tokensSold: bigint;
  creator: Address;
  createdAt: number;
  graduated: boolean;
  exists: boolean;
};

/**
 * Solidity flattens a struct-valued public mapping getter into positional
 * returns, so this arrives as an 8-tuple rather than an object.
 */
export function decodePool(raw: unknown): Pool | null {
  if (!Array.isArray(raw) || raw.length < 8) return null;
  const t = raw as [
    bigint,
    bigint,
    bigint,
    bigint,
    Address,
    number,
    boolean,
    boolean,
  ];
  return {
    ethReserve: t[0],
    tokenReserve: t[1],
    realEthRaised: t[2],
    tokensSold: t[3],
    creator: t[4],
    createdAt: Number(t[5]),
    graduated: t[6],
    exists: t[7],
  };
}

/** A token's pair, with its reserves already oriented ETH-side-first. */
export type PoolQuote = {
  pair: Address;
  ethReserve: bigint;
  tokenReserve: bigint;
  /** Which side of the pair WETH sorted onto — the `Swap` log decoder needs it. */
  wethIsToken0: boolean;
};

/**
 * The half of a {@link PoolQuote} that can never change.
 *
 * A V2 pair's address is fixed by its two tokens — `createPair` reverts if one
 * already exists — and which leg WETH sorted onto is fixed with it. The reserves
 * beside them are live data, and separating the two is what lets a log scan resolve
 * a pair once per process instead of once per read: decoding a historical `Swap`
 * needs the orientation, never today's reserves.
 *
 * A subset of `PoolQuote` rather than a parallel type, so the one place that decides
 * which leg is ETH stays the one place — see `sideFor` in lib/server-dex.ts.
 */
export type PairSide = Pick<PoolQuote, "pair" | "wethIsToken0">;

export type Listing = {
  token: Address;
  name: string;
  symbol: string;
  /** Whatever the creator set. Resolved into art by lib/metadata.ts. */
  metadataURI: string;
  pool: Pool;
  priceE18: bigint;
  marketCap: bigint;
  progress: number;
  /** True once price is coming from the DEX pair rather than the closed curve. */
  fromPool: boolean;
};

/**
 * Which reserves a token is priced off.
 *
 * Before graduation that is the curve. After it, the curve's reserves are frozen
 * at their final values forever — the launchpad never writes them again — so a
 * graduated token has to be priced off its pair or the page would show a number
 * that no trade can move. The two differ by construction: the 5% graduation fee
 * comes out of the ETH before the pool is seeded, so a curve that closed at 25
 * gwei opens its pool nearer 19.
 *
 * Falls back to the frozen reserves while the pair reads are still in flight,
 * which keeps the layout stable instead of flashing a zero.
 */
export function priceSource(pool: Pool, quote: PoolQuote | undefined) {
  if (pool.graduated && quote && quote.tokenReserve > 0n) {
    return {
      ethReserve: quote.ethReserve,
      tokenReserve: quote.tokenReserve,
      fromPool: true,
    };
  }
  return {
    ethReserve: pool.ethReserve,
    tokenReserve: pool.tokenReserve,
    fromPool: false,
  };
}

/**
 * How many launches `/api/market` reads in one page, and therefore the widest
 * window any caller can ask for.
 *
 * One number for the whole app on purpose. Putting the caller's `limit` in the URL
 * would give the shared cache a key per distinct limit — 40 for the market page,
 * 100 for /swap and /profile — which is three times the RPC work for three subsets
 * of the same answer. So the route always reads `MARKET_LIMIT`, and
 * `useListings(limit)` takes the front of it. 100 is what the widest caller
 * (`WINDOW` in lib/profile.ts) needs; a caller asking for more is silently served
 * this, which is why the profile page shows its own "older launches are outside this
 * window" notice off `tokenCount`.
 *
 * It is now also the paging step, which is the same argument one level up. The market
 * page shows 24 or 12 at a time, so keying the read on *its* page size would multiply
 * the cache by view as well as by position; instead a page of the market is one of
 * these, the browser walks it 24 at a time, and only crossing the edge is a fetch.
 * Cache keys stay `sorts × ceil(tokenCount / MARKET_LIMIT)` rather than growing with
 * the controls.
 */
export const MARKET_LIMIT = 100;

/**
 * The orderings `/api/market` can be asked for.
 *
 * Three of the five are things a browser could do for itself over a page it has already
 * been sent — `new` is the order it arrives in, `progress` and `cap` are columns on every
 * listing. `volume` and `active` are not, and that is the point: they order rows the app
 * was never sent, so they only mean anything where the whole market is available to
 * order. See `MarketState.whole`.
 *
 * `volume` is lifetime volume, not a window. "Most traded ever" is a different question
 * from "busiest today" and it is the one a counter can answer; the labels on the control
 * say which. See the note on `/market` in indexer/src/api/index.ts.
 */
export const MARKET_SORTS = ["new", "progress", "cap", "volume", "active"] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

/** Narrows a query parameter or a wire field, both of which are anyone's to send. */
export function isMarketSort(value: unknown): value is MarketSort {
  return (
    typeof value === "string" && (MARKET_SORTS as readonly string[]).includes(value)
  );
}

/**
 * Everything about a chain's market that is the same for every visitor.
 *
 * Not in here: anything keyed to an address. Balances, allowances and the
 * connected wallet's positions stay direct reads — see the note in lib/server-rpc.ts.
 *
 * Nor the pair state behind the graduated listings, which the route resolves and
 * spends on pricing but does not ship. It was on the wire for one consumer — the
 * volume scan needed the pair addresses to read their `Swap` logs — and that scan
 * now resolves them server-side too. A hundred graduated listings' worth of
 * reserves is real weight on a document fetched every few seconds per region, and
 * nothing in the browser reads it.
 *
 * The last three fields describe the answer rather than the market, and they are here
 * because "sort by volume, page four" is a question only one of the two sources can
 * answer. The route takes the request either way and says what it managed — so a page
 * that asked for something the chain cannot order gets the newest launches *and is told
 * so*, instead of a control that silently does nothing.
 */
export type MarketState = {
  chainId: number;
  launchpad: Address;
  /** Launches ever, which is more than `listings.length` once past the window. */
  tokenCount: bigint;
  /** In `sort` order, already priced. */
  listings: Listing[];
  /** The ordering actually applied, which is `"new"` whenever `whole` is false. */
  sort: MarketSort;
  /** Where this page starts in that ordering. A multiple of `MARKET_LIMIT`. */
  offset: number;
  /**
   * Whether `sort` and `offset` range over the whole market or only its newest page.
   *
   * True when an indexer served this, where a page is one `SELECT` with an `ORDER BY`.
   * False on the RPC path, which walks the launchpad's index counter downwards and so
   * can only ever offer the newest — ordering by market cap or volume needs every
   * launch's figures to exist first, and reading them all is the four hundred contract
   * calls this route exists to avoid.
   */
  whole: boolean;
};

/**
 * One token's public half — everything `useTokenDetail` used to batch except the
 * two reads that belong to a wallet rather than a token.
 *
 * `pool` is null when there is no launch at the address, which the token page
 * renders as its own "no launch here" state rather than a 404.
 */
export type TokenState = {
  chainId: number;
  token: Address;
  pool: Pool | null;
  name: string;
  symbol: string;
  metadataURI: string;
  totalSupply: bigint;
  /** The DEX pair, once the curve has graduated into one. */
  pair: PoolQuote | null;
  priceE18: bigint;
  marketCap: bigint;
  progress: number;
  /** True once price is coming from the pair rather than the closed curve. */
  fromPool: boolean;
};

/* ---------------------------------------------------------------------------
 * Decoding the wire form.
 *
 * Field by field rather than by a generic reviver, for the reason lib/wire.ts
 * gives: a string on the wire is a quantity or it is a creator-supplied `name`,
 * and only the schema knows which. Numbers go through `big`, which throws — so a
 * truncated or wrong-shaped payload fails the query and the page renders its
 * loading state, instead of quietly showing a market priced at zero.
 * ------------------------------------------------------------------------- */

function fields(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WireError(`${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function addr(value: unknown, what: string): Address {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    return value as Address;
  }
  throw new WireError(`${what}: expected an address`);
}

/** Creator-supplied text. Missing is "", never an error — see `name` in the route. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodePoolWire(raw: unknown): Pool {
  const p = fields(raw, "pool");
  return {
    ethReserve: big(p.ethReserve),
    tokenReserve: big(p.tokenReserve),
    realEthRaised: big(p.realEthRaised),
    tokensSold: big(p.tokensSold),
    creator: addr(p.creator, "pool.creator"),
    createdAt: Number(p.createdAt) || 0,
    graduated: p.graduated === true,
    exists: p.exists === true,
  };
}

function decodeQuote(raw: unknown): PoolQuote {
  const q = fields(raw, "quote");
  return {
    pair: addr(q.pair, "quote.pair"),
    ethReserve: big(q.ethReserve),
    tokenReserve: big(q.tokenReserve),
    wethIsToken0: q.wethIsToken0 === true,
  };
}

function decodeListing(raw: unknown): Listing {
  const l = fields(raw, "listing");
  return {
    token: addr(l.token, "listing.token"),
    name: text(l.name),
    symbol: text(l.symbol),
    metadataURI: text(l.metadataURI),
    pool: decodePoolWire(l.pool),
    priceE18: big(l.priceE18),
    marketCap: big(l.marketCap),
    progress: Number(l.progress) || 0,
    fromPool: l.fromPool === true,
  };
}

export function decodeMarket(raw: unknown): MarketState {
  const m = fields(raw, "market");
  if (!Array.isArray(m.listings)) throw new WireError("market.listings: expected an array");

  return {
    chainId: Number(m.chainId),
    launchpad: addr(m.launchpad, "market.launchpad"),
    tokenCount: big(m.tokenCount),
    listings: m.listings.map(decodeListing),
    // The three that describe the answer are read leniently, where every quantity above
    // throws. They are not figures, they are what the route managed — and the safe
    // reading of a missing one is the conservative one: newest launches, first page, do
    // not offer the sorts that need an indexer. A payload from an older deployment
    // degrades to what that deployment did rather than failing the query.
    sort: isMarketSort(m.sort) ? m.sort : "new",
    offset: Number(m.offset) || 0,
    whole: m.whole === true,
  };
}

export function decodeToken(raw: unknown): TokenState {
  const t = fields(raw, "token");
  return {
    chainId: Number(t.chainId),
    token: addr(t.token, "token.token"),
    // Null is a real answer here — no launch at this address — and distinct from a
    // malformed payload, which `decodePoolWire` throws on.
    pool: t.pool === null || t.pool === undefined ? null : decodePoolWire(t.pool),
    name: text(t.name),
    symbol: text(t.symbol),
    metadataURI: text(t.metadataURI),
    totalSupply: big(t.totalSupply),
    pair: t.pair === null || t.pair === undefined ? null : decodeQuote(t.pair),
    priceE18: big(t.priceE18),
    marketCap: big(t.marketCap),
    progress: Number(t.progress) || 0,
    fromPool: t.fromPool === true,
  };
}
