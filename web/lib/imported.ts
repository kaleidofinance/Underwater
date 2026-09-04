import type { Address } from "viem";

/**
 * Imported tokens we have actually looked at.
 *
 * `createPair` on our factory takes no owner check — anyone may pair any two tokens
 * against WETH and start trading them here. That is the point of it, and it is also
 * the whole problem: a pair called USDC with a tenth of an ETH behind it is the same
 * three transactions as a real import, and from the outside the two look identical.
 * Every venue that lets a stranger add a market ends up needing this list, and the
 * ones that skip it end up needing it retroactively.
 *
 * So the rule is: **an imported pool always trades, and only a listed one is
 * presented as anything.** Nothing here gates a swap. The router will route to any
 * pair that exists whether it is on this list or not, because refusing to quote a
 * pool that visibly holds liquidity would be a lie of a different kind. What the list
 * gates is our voice: whether the page says "this is the token it claims to be", and
 * whether it may appear anywhere a reader did not paste the address themselves.
 *
 * Deliberately a file and not a contract, and deliberately not an env var. A registry
 * on chain would need an owner, a transaction per listing and a migration the first
 * time its shape was wrong; a comma-separated env var would put the same decision
 * somewhere with no review and no history. This ships in a commit, which is the
 * review — and `git log` on this file is the record of what we vouched for and when.
 *
 * Empty per chain until somebody imports something. That is the honest state: no
 * imports have been made on any network yet, and a seeded example would be a claim
 * about a token that does not exist.
 */

/** One vetted import. `symbol` is what we expect, not what the contract says. */
export type Imported = {
  address: Address;
  /**
   * The symbol as of listing, kept so the page can catch a contract whose `symbol()`
   * does not match what was vouched for. An upgradeable proxy can change its answer
   * after the fact, and this is the only copy that predates it.
   */
  symbol: string;
  /** One line on why this is here, shown on the token's page. */
  note: string;
};

/**
 * By chain id, because a token address means nothing without one — the same twenty
 * bytes are a stablecoin on one network and unclaimed on the next, and a list keyed
 * only on the address would carry a listing across a chain switch.
 */
const LISTED: Record<number, readonly Imported[]> = {};

/** Every vetted import on a chain, in listing order. */
export function importsOn(chainId: number): readonly Imported[] {
  return LISTED[chainId] ?? [];
}

/**
 * The listing for a token, if we have one.
 *
 * Lowercased on both sides: an address arrives from a URL, a paste or a contract read,
 * and those three disagree about checksum casing constantly. A registry that missed a
 * listing over capitalisation would show an "unverified" warning on a token we had in
 * fact vouched for, which is the failure that teaches readers to ignore the warning.
 */
export function importOf(
  chainId: number,
  token: Address | undefined,
): Imported | undefined {
  if (!token) return undefined;
  const want = token.toLowerCase();
  return importsOn(chainId).find((row) => row.address.toLowerCase() === want);
}
