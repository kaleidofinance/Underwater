"use client";

import { fmtSpan } from "@/lib/format";
import { moveBps } from "@/lib/scans";
import { useMarketVolume } from "@/lib/stats";

/**
 * What a launch's price has done since the window opened, beside the price itself.
 *
 * The opening price rides the volume scan — see the price track in /api/volume and `Day`
 * in lib/scans.ts — so a hundred cards showing a change cost no requests at all. This
 * calls the same hook the market's stat cards call, on the same query key, so every card
 * on the page reads one document and react-query hands each of them the cached copy.
 *
 * The division happens here rather than on the server because the two halves of it live
 * on different documents: the current price is on /api/market's three-second window and
 * the opening price is on a twenty-second log scan. Pinning them together would mean
 * re-scanning a day of logs every time a price moved.
 *
 * Renders nothing at all when there is no answer — no scan yet, or a launch that has not
 * traded inside the scan's reach. A dash would say "loading" on a card that is otherwise
 * complete, and a zero would be a claim: "it has not moved" is a different statement from
 * "nothing here says what it was worth". A launch that traded before the window and not
 * since does show 0.0%, which is true, and gets no arrow — an arrow is a direction and
 * flat has none.
 *
 * The triangle is drawn rather than typed. ▲ and ▼ are not in JetBrains Mono, so they
 * fall back to whatever the platform has, at a size and baseline this sheet does not
 * control — at 9.5px that lands as a smudge sitting above or below the digits. A polygon
 * in `currentColor` takes the colour of the class and the size given here.
 */
export function DayChange({
  token,
  priceE18,
}: {
  token: string;
  priceE18: bigint;
}) {
  const { volume } = useMarketVolume();
  const day = volume?.day;
  if (!day) return null;

  const bps = moveBps(day.opens[token.toLowerCase()], priceE18);
  if (bps === null) return null;

  const dir = bps > 0 ? "rise" : bps < 0 ? "fall" : "flat";

  return (
    <span
      className={`chg ${dir}`}
      title={`price change over the last ${fmtSpan(day.seconds)}`}
    >
      {dir !== "flat" && (
        <svg viewBox="0 0 10 10" width="7" height="7" aria-hidden="true">
          <polygon
            points={dir === "rise" ? "5,1.5 9,8.5 1,8.5" : "5,8.5 9,1.5 1,1.5"}
            fill="currentColor"
          />
        </svg>
      )}
      {bps > 0 ? "+" : ""}
      {(bps / 100).toFixed(1)}%
    </span>
  );
}
