"use client";

import { CURVE } from "@/lib/contracts";
import { fmtEth, fmtSpan } from "@/lib/format";
import { fmtUsd, useEthUsd, usdFromWei } from "@/lib/usd";
import { useLaunchpadConfig, type Listing } from "@/lib/hooks";
import { marketTotals, useMarketVolume } from "@/lib/stats";

/**
 * What the market is actually doing, in five cards.
 *
 * This replaced a strip of deployment facts — chain name, chain id, contract
 * address — which described the app's configuration rather than its market. That
 * belongs in the network switcher, and does now; the space above the list is for
 * the numbers someone came to read.
 *
 * Three of the five cost nothing extra: the market list already carries every
 * cap, and the launchpad keeps its own ETH counter. Volume is the one that needs
 * a log scan, and Fees rides on it — protocol revenue across every product, not
 * the curves' cut of trading, so a launch, a graduation and a pool swap are all in
 * there beside the trades. Both are labelled with the window they cover and nothing
 * else, in one sentence built once and rendered twice: they are one read, and a card
 * quoting a window the card beside it contradicts is worse than either number alone.
 */
export function MarketStats({ listings }: { listings: readonly Listing[] }) {
  const { totalCurveEth, tokenCount } = useLaunchpadConfig();
  const { volume, error, seconds } = useMarketVolume();
  const { marketCap, graduated, live, total } = marketTotals(listings);
  const ethUsd = useEthUsd();

  // Dollars lead, the ETH figure trails dim — same shape for all three ETH
  // cards, so the price feed being down degrades them to plain ETH together.
  const usdEth = (wei: bigint) =>
    ethUsd ? (
      <>
        {fmtUsd(usdFromWei(wei, ethUsd))}{" "}
        <span className="dim">· {fmtEth(wei)} ETH</span>
      </>
    ) : (
      <>{fmtEth(wei)} ETH</>
    );

  // The market list is capped at its newest page, so past that the cap and the
  // counts describe a subset. Say which subset rather than presenting a partial
  // sum as the whole market — the volume scan and the curve balance are unaffected
  // (one reads every log, the other is the contract's own counter).
  const clipped = tokenCount > BigInt(total);

  // The window the scan covers — "24hrs" while it is still reaching back, "all time"
  // once it has the whole history — and that is the entire sub-line on both cards now.
  //
  // It used to trail a trade count on one and "launch to pool" on the other, and
  // neither was what a total needs said beside it. A count is a second statistic
  // competing with the one in the card, and a list of the products a fee total spans
  // belongs in the docs; the span a total is a total *of* is the thing a reader cannot
  // work out for themselves. Blocks are how the scan measures that span and hours are
  // how it is read, so `useMarketVolume` converts — the block count survives only for
  // a chain that declares no block time.
  //
  // "all time" is a shade pessimistic on the fee card, and only ever in that direction:
  // the launch leg comes off a contract counter, so it is whole even while the log legs
  // are still reaching back. Understating what a total covers is the safe half of that.
  const span = !volume
    ? ""
    : volume.allTime
      ? "all time"
      : seconds !== undefined
        ? fmtSpan(seconds)
        : `${volume.blocks.toLocaleString()} blocks`;

  // Built once and rendered under both figures. Two copies of this would be two places
  // for the window, the wording, and the failure states to drift apart.
  const note = error ? "this RPC would not answer" : !volume ? "sounding…" : span;

  return (
    <dl className="stats">
      <div className="stat">
        <dt>Volume</dt>
        <dd>{volume ? usdEth(volume.eth) : "—"}</dd>
        <span className="stat-sub">{note}</span>
      </div>

      <div className="stat">
        <dt>Fees</dt>
        <dd>{volume ? usdEth(volume.fees.total) : "—"}</dd>
        <span className="stat-sub">{note}</span>
      </div>

      <div className="stat">
        <dt>On the curves</dt>
        <dd>{usdEth(totalCurveEth)}</dd>
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
        <dd>{usdEth(marketCap)}</dd>
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
