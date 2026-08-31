"use client";

import Link from "next/link";
import { fmtPoints, type Rates } from "@/lib/points";
import { useRateCard } from "@/lib/points-client";

/**
 * uwPoints where the earning happens.
 *
 * Points used to be visible only on the profile, which made them a page rather than a
 * mechanic: you could launch a token, trade all afternoon and never learn that either
 * paid. These are the two lines that fix that — what an action is about to be worth, and
 * what it turned out to be worth — and they live in one file so the number quoted before
 * a transaction and the number confirmed after it cannot come from two different places.
 *
 * Both read the rate card off the chain rather than lib/points.ts's `RATES_FALLBACK`, and
 * both render nothing when there is no contract to read it from. That is the important
 * decision here: the fallback is fine on the profile, where it can be labelled indicative
 * beside a total, but a button that promises "+20,000 uwPoints" from a guess is a promise
 * nothing can keep. No contract, no claim.
 *
 * Nor is a zero rate a claim. A rate can legitimately be set to nothing — swaps might
 * stop paying — and "earns +0 uwPoints" is worse than silence.
 */

/** The actions these cues cover. Not plates: no rate on the contract prices a mint. */
export type PointAction = "create" | "trade";

function priceOf(action: PointAction, rates: Rates): bigint {
  return action === "create" ? rates.create : rates.swap;
}

/**
 * What one action is worth right now, and whether the chain said so.
 *
 * Exported because the create page wants the figure in its own summary list rather than
 * as prose — the same read, rendered as one more row beside the creation fee and the
 * total to send.
 */
export function usePointsFor(action: PointAction) {
  const { rates, onChain } = useRateCard();
  const points = priceOf(action, rates);
  return { points, onChain, quotable: onChain && points > 0n };
}

/** `uwPoints  +20,000` as an `.r-row`, for a summary list that already has one. */
export function PointsRow({ action }: { action: PointAction }) {
  const { points, quotable } = usePointsFor(action);
  if (!quotable) return null;
  return (
    <div className="r-row">
      <dt>uwPoints</dt>
      <dd className="gold">+{fmtPoints(points)}</dd>
    </div>
  );
}

/**
 * The receipt: what it did earn.
 *
 * `.alert.ok` — the sheet's "this worked" panel — because the transaction confirming is
 * the news and the points are the part of it we can add. Shown until the next write
 * clears the hash, so it behaves like a receipt on the counter rather than a toast.
 *
 * The link out is to the profile, not to the transaction: somebody who just earned points
 * wants the running total, and the explorer link for the trade itself is already in the
 * history list they would land in.
 */
export function EarnedPoints({
  action,
  show,
}: {
  action: PointAction;
  /// The engine's `settled` — true for a confirmed trade, false for a confirmed approval.
  show: boolean;
}) {
  const { points, quotable } = usePointsFor(action);
  if (!show || !quotable) return null;
  return (
    <div className="alert ok pts-earned">
      Settled — <b>+{fmtPoints(points)} uwPoints</b>.{" "}
      <Link href="/profile" className="link">
        Your balance and history
      </Link>{" "}
      update within a minute.
    </div>
  );
}
