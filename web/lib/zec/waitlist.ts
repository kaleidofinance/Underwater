/** The pre-launch waitlist, as the API speaks it (zec/server/waitlist.ts). */

export interface WaitlistStanding {
  code: string;
  handle: string;
  rank: number;
  points: number;
  referrals: number;
  joinedAt: number;
  /** Ids of the tasks this person has done. */
  tasks: string[];
}

/** Something to do on X for points (the list lives on the server). */
export interface WaitlistTask {
  id: string;
  label: string;
  url: string;
  points: number;
}

export interface WaitlistBoard {
  count: number;
  top: Array<Pick<WaitlistStanding, "handle" | "rank" | "points" | "referrals">>;
  tasks: WaitlistTask[];
}

export const JOIN_POINTS = 100;
/** The top of the waitlist mints a free Underwater Plate. */
export const FREE_MINT_RANKS = 500;
export const PLATE_SUPPLY = 4444;
export const PUBLIC_MINT_PRICE = "0.1";
/** Previews from the real collection (numbers before reveal). */
export const PREVIEW_PLATES = ["0005", "0006", "0012", "0024", "0035", "0088", "0091", "0093"];

/** Where someone stands relative to the free mint. */
export function freeMintLine(rank: number): string {
  return rank <= FREE_MINT_RANKS
    ? "on track for a free Underwater Plate"
    : `${rank - FREE_MINT_RANKS} spots from a free Underwater Plate`;
}
export const REFERRAL_POINTS = 50;

/** Where a referral link lands. The /r page carries the person's card for X to unfurl, then sends visitors home. */
export const referralUrl = (site: string, code: string) => `${site.replace(/\/+$/, "")}/r/${code}`;

/** What a post on X says. The link carries the card. */
export function shareText(s: Pick<WaitlistStanding, "rank">): string {
  const prize =
    s.rank <= FREE_MINT_RANKS ? "The top 500 mint a free Underwater Plate, and I'm in." : "The top 500 mint a free Underwater Plate.";
  return `I'm #${s.rank} in line for underwater.fun, the meme launchpad coming to Zcash. ${prize}\n\nJoin with my link and we both earn points:`;
}

/** Remember a referral code from the URL, so it survives until the visitor signs up. */
export const REF_KEY = "uwzec:ref:v1";
