"use client";

import type { PoolQuote } from "@/lib/dex";
import { CURVE } from "@/lib/contracts";
import { fmtEth } from "@/lib/format";
import { useLaunchpadConfig, type Listing } from "@/lib/hooks";
import { marketTotals, useMarketVolume } from "@/lib/stats";

/**
 * What the market is actually doing, in four cards.
 *
 * This replaced a strip of deployment facts — chain name, chain id, contract
 * address — which described the app's configuration rather than its market. That
 * belongs in the network switcher, and does now; the space above the list is for
 * the numbers someone came to read.
 *
 * Three of the four cost nothing extra: the market list already carries every
 * cap, and the launchpad keeps its own ETH counter. Volume is the one that needs
 * a log scan, so it says which window it managed to read.
 */
export function MarketStats({
  listings,
  pairs,
}: {
  listings: readonly Listing[];
  pairs: readonly PoolQuote[];
}) {
  const { totalCurveEth, tokenCount } = useLaunchpadConfig();
  const { volume, error } = useMarketVolume(pairs);
  const { marketCap, graduated, live, total } = marketTotals(listings);

  // The market list is capped at its newest page, so past that the cap and the
  // counts describe a subset. Say which subset rather than presenting a partial
  // sum as the whole market — the volume scan and the curve balance are unaffected
  // (one reads every log, the other is the contract's own counter).
  const clipped = tokenCount > BigInt(total);

  return (
    <dl className="stats">
      <div className="stat">
        <dt>Volume</dt>
        <dd>{volume ? `${fmtEth(volume.eth)} ETH` : "—"}</dd>
        <span className="stat-sub">
          {error
            ? "this RPC would not serve the range"
            : !volume
              ? "sounding…"
              : `${volume.trades.toLocaleString()} trades · ${
                  volume.allTime
                    ? "all time"
                    : `last ${volume.blocks.toLocaleString()} blocks`
                }`}
        </span>
      </div>

      <div className="stat">
        <dt>On the curves</dt>
        <dd>{fmtEth(totalCurveEth)} ETH</dd>
        <span className="stat-sub">
          {clipped
            ? "raised and not yet graduated"
            : live === 0
              ? "no open curves"
              : `held across ${live} open curve${live === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="stat">
        <dt>Market cap</dt>
        <dd>{fmtEth(marketCap)} ETH</dd>
        <span className="stat-sub">
          {clipped
            ? `newest ${total} of ${tokenCount.toLocaleString()} launches`
            : `${total} launch${total === 1 ? "" : "es"} combined`}
        </span>
      </div>

      <div className="stat">
        <dt>Graduated</dt>
        <dd className={graduated > 0 ? "ok" : undefined}>
          {graduated} of {total}
        </dd>
        <span className="stat-sub">
          at {fmtEth(CURVE.graduationEth)} ETH, LP burned
        </span>
      </div>
    </dl>
  );
}
