import type { Address } from "viem";
import { keccak256, toHex } from "viem";
import { anvil, ink, inkSepolia } from "./chains";
import { envAddress } from "./contracts";

/**
 * uwPoints: the arithmetic, the types, and the code generator.
 *
 * No `"use client"` on purpose. The route handler that counts the logs and the
 * browser that renders the card have to agree on this arithmetic exactly, and a
 * server import of a client module gets a reference rather than a value — the
 * failure `PLATES` in lib/contracts.ts documents, which failed a production build
 * rather than a page. The hooks live in lib/points-client.ts; everything here is
 * pure and safe on either side.
 *
 * The one thing worth understanding before reading further: **a balance is not
 * stored anywhere.** It is
 *
 *     rates × counts of on-chain logs + granted[who]
 *
 * recomputed on every read. `UnderwaterPoints` holds the rates and the grants;
 * every count comes from an event the waitlist, the launchpad and the pairs have
 * been emitting since they were deployed. The contract's own docblock argues the
 * case for that shape; what it means *here* is that this module has no notion of
 * spending, no ledger to reconcile, and no ordering to get right.
 */

/// The points contract, per chain. Independent of every other deploy — a chain can
/// have the launchpad, the collection and the waitlist and no points contract,
/// which is the state a chain is in before this is deployed to it. The pages read
/// `pointsFor()` and fall back to showing the counts without a total.
const ENV: Record<number, string | undefined> = {
  [ink.id]: process.env.NEXT_PUBLIC_POINTS_INK,
  [inkSepolia.id]: process.env.NEXT_PUBLIC_POINTS_INK_SEPOLIA,
  [anvil.id]: process.env.NEXT_PUBLIC_POINTS_ANVIL,
};

export function pointsFor(chainId: number | undefined): Address | null {
  if (chainId === undefined) return null;
  return envAddress(ENV[chainId]);
}

/**
 * The block each chain's scan starts from.
 *
 * Points are all-time — a registration from six months ago still counts — so the
 * scan cannot use the bounded "wide then narrow" window `lib/stats.ts` uses for
 * volume. It has to reach the first of our deploys, and the cheapest way to make
 * that affordable is to be told where that is instead of starting at genesis.
 *
 * Wrong-but-too-early is safe and only slow. Wrong-but-too-late silently drops
 * everything before it, so leave this unset rather than guessing: unset scans from
 * genesis, which is correct and merely expensive.
 */
export function pointsFromBlock(chainId: number | undefined): bigint {
  const raw =
    chainId === ink.id
      ? process.env.POINTS_FROM_BLOCK_INK
      : chainId === inkSepolia.id
        ? process.env.POINTS_FROM_BLOCK_INK_SEPOLIA
        : undefined;
  if (!raw) return 0n;
  try {
    const n = BigInt(raw.trim());
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

/**
 * What each action is worth. Mirrors `UnderwaterPoints.Rates`.
 *
 * `bigint` rather than `number` because the contract's fields are `uint64`, whose
 * top end is past `Number.MAX_SAFE_INTEGER`. Nobody will set a rate that large,
 * but the type should not be the thing that assumes so.
 */
export type Rates = {
  register: bigint;
  referral: bigint;
  create: bigint;
  swap: bigint;
};

/**
 * The rates used when no points contract is deployed on the connected chain.
 *
 * The launch numbers, and the same ones `script/DeployPoints.s.sol` defaults to.
 * They exist so a chain without the contract can still show a coherent card
 * instead of zeroes — clearly labelled as indicative, because the moment the
 * contract is deployed its rates are the real ones and these are a guess about
 * history.
 */
export const RATES_FALLBACK: Rates = {
  register: 10_000n,
  referral: 1_000n,
  create: 20_000n,
  swap: 10n,
};

/** What an address did, counted from logs. Counts, not points. */
export type PointCounts = {
  /** Registered on the waitlist. Worth `rates.register`, once. */
  registered: boolean;
  /** Every registration through their link, valid or not. Shown, not paid. */
  referrals: number;
  /** The subset that clears the activity bar. This is what pays. */
  validReferrals: number;
  /** Tokens launched on the launchpad. */
  creates: number;
  /** Curve buys and sells plus AMM swaps, counted together. */
  trades: number;
};

export const NO_COUNTS: PointCounts = {
  registered: false,
  referrals: 0,
  validReferrals: 0,
  creates: 0,
  trades: 0,
};

/** A balance, and every term that went into it. */
export type PointsBreakdown = {
  registration: bigint;
  referral: bigint;
  creation: bigint;
  trading: bigint;
  /** Redeemed coupons and hand grants, read from the contract. */
  granted: bigint;
  total: bigint;
};

/**
 * The balance, and the only place it is ever computed.
 *
 * Shared by the route and the browser deliberately: the card shows a total beside
 * the terms that add up to it, and two implementations of this sum is how a card
 * ends up displaying four numbers and a fifth that is not their total.
 */
export function pointsFrom(
  counts: PointCounts,
  rates: Rates,
  granted: bigint,
): PointsBreakdown {
  const registration = counts.registered ? rates.register : 0n;
  const referral = BigInt(counts.validReferrals) * rates.referral;
  const creation = BigInt(counts.creates) * rates.create;
  const trading = BigInt(counts.trades) * rates.swap;

  return {
    registration,
    referral,
    creation,
    trading,
    granted,
    total: registration + referral + creation + trading + granted,
  };
}

/** `1,412` — points are whole numbers, so no decimals to think about. */
export function fmtPoints(n: bigint): string {
  return n.toLocaleString("en-US");
}

/**
 * `1,412.000` — the balance, written the way a balance is written.
 *
 * The same number as {@link fmtPoints}, padded to three places. Nothing about the
 * arithmetic has decimals in it: rates are whole, counts are whole, and the sum of two
 * whole numbers has nothing after the point. The three zeroes are there because this is
 * the figure that sits under a ticker beside `0.0005 ETH` in the masthead, and a bare
 * `0` next to that reads as a count of something rather than a balance of it.
 *
 * So it is for the total only. The terms that add up to it keep {@link fmtPoints} — a
 * rate reads as `20,000 each`, and `20,000.000 each` would be claiming a precision the
 * contract has no way to express.
 */
export function fmtPointsAmount(n: bigint): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

// ─── History ──────────────────────────────────────────────────────────────

/**
 * Which stream one row of history came from.
 *
 * The same five things `PointCounts` counts, plus the two that are not counted at all
 * but read off the contract's own logs. A row's kind decides its copy, its icon and —
 * for everything but a coupon or a grant — which rate prices it.
 */
export type PointEventKind =
  | "register"
  | "referral"
  | "create"
  | "trade"
  | "coupon"
  | "grant";

/**
 * One thing a wallet did, priced.
 *
 * The counterpart to {@link PointCounts}: same events, same rates, one row each instead
 * of a total. Which is the point of it — a balance is arithmetic nobody can check, and a
 * list of the events it was computed from is arithmetic anybody can. `pointsFrom` over
 * the counts and the sum of every row's `points` are the same number by construction,
 * and if they ever differ the list is the one that can be argued with.
 *
 * `points` is priced at the **current** rate card, not at whatever the rate was on the
 * day. That is not a shortcut either: the contract stores no history of rates and a
 * balance is recomputed on every read, so a rate change re-prices what is already here —
 * which is exactly what the card's footnote promises.
 */
export type PointEvent = {
  kind: PointEventKind;
  /// Block and log index, which together order the list and key it. Newest first.
  block: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  /// Unix seconds. Zero while a block's timestamp has not been fetched yet — the row
  /// is real, its date is not known, and the UI shows the block instead of guessing.
  at: number;
  /// What this row is worth right now. Zero for a referral still short of the bar.
  points: bigint;
  /// The token launched or traded, and its ticker when one could be resolved.
  token?: Address;
  symbol?: string;
  /// The wallet referred, for a referral row.
  referee?: Address;
  /// True when a referral has not cleared the activity bar — either it has not been
  /// checked yet or the wallet does not qualify. Priced at zero either way.
  pending?: boolean;
  /// Buy or sell, and where.
  isBuy?: boolean;
  venue?: "curve" | "pool";
  /// The reason typed into a hand grant's calldata.
  reason?: string;
};

/** One address's history, as far back as it has been read. */
export type PointHistory = {
  events: PointEvent[];
  /// True when there is older history than this page — either rows already found and
  /// not shown, or blocks not walked yet.
  more: boolean;
  /// True when the walk has reached the first of our deployments, so the list really is
  /// everything this wallet has ever done rather than the recent part of it.
  allTime: boolean;
  /// True while some row's date or some referral's verdict is still missing.
  partial: boolean;
};

// ─── Coupons ──────────────────────────────────────────────────────────────

/**
 * The alphabet coupon codes are drawn from: Crockford base32, which drops `I`,
 * `L`, `O` and `U`.
 *
 * `I`/`1`, `O`/`0` and `L`/`1` are the pairs a person reads off a sticker wrong,
 * and `U` is dropped so a random code cannot spell something we would rather it
 * did not. 32 symbols, so each character is exactly five bits and the entropy is
 * countable rather than estimated.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Characters of randomness per code. 12 × 5 bits = 60 bits. */
const CODE_LEN = 12;

/**
 * A fresh coupon code, e.g. `UW-7QK4-9ZTD-1M3X`.
 *
 * 60 bits of `crypto.getRandomValues`, which is what makes the contract's
 * guessing story hold: `couponState` will tell anyone whether a hash is live, so
 * codes have to be expensive to guess rather than merely private. Derived codes —
 * a campaign name, a date, a wallet's last four — are the failure this exists to
 * prevent.
 *
 * The `UW-` prefix and the grouping are not part of the entropy; they are so
 * somebody reading a code out loud knows where it starts and ends. Both are inside
 * the hash, because `redeem` compares bytes and normalising would shrink the space.
 *
 * Rejection sampling on the byte, not `% 32`: 256 is a multiple of 32, so a plain
 * modulo would be uniform here — but it stops being uniform the moment somebody
 * edits the alphabet, and a silently biased code generator is not a thing worth
 * leaving as a tripwire.
 */
export function newCouponCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);

  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    let b = bytes[i];
    while (b >= 256 - (256 % ALPHABET.length)) {
      const one = new Uint8Array(1);
      crypto.getRandomValues(one);
      b = one[0];
    }
    out += ALPHABET[b % ALPHABET.length];
  }

  return `UW-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/**
 * The key a coupon is stored under: `keccak256(bytes(code))`.
 *
 * The only hash the chain ever sees. `issue` takes hashes precisely so the codes
 * can be generated on the owner's machine, hashed there, and handed out by
 * whatever channel they are handed out by — calldata is public, and a code in
 * calldata is a code spent by whoever read the mempool first.
 */
export function couponCodeHash(code: string): `0x${string}` {
  return keccak256(toHex(code));
}
