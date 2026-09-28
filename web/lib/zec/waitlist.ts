/** The pre-launch waitlist, as the API speaks it (zec/server/waitlist.ts). */

export interface WaitlistStanding {
  code: string;
  handle: string;
  rank: number;
  points: number;
  referrals: number;
  joinedAt: number;
}

export interface WaitlistBoard {
  count: number;
  top: Array<Pick<WaitlistStanding, "handle" | "rank" | "points" | "referrals">>;
}

export const JOIN_POINTS = 100;
export const REFERRAL_POINTS = 50;

/** Where a referral link lands. The /r page carries the person's card for X to unfurl, then sends visitors home. */
export const referralUrl = (site: string, code: string) => `${site.replace(/\/+$/, "")}/r/${code}`;

/** What a post on X says. The link carries the card. */
export function shareText(s: Pick<WaitlistStanding, "rank">): string {
  return `I'm #${s.rank} in line for underwater.fun, the meme launchpad coming to Zcash. Launch a token in seconds, trade it instantly.\n\nJoin with my link and we both earn points:`;
}

/** Remember a referral code from the URL, so it survives until the visitor signs up. */
export const REF_KEY = "uwzec:ref:v1";
