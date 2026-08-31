"use client";

import { CURVE } from "@/lib/contracts";
import { fmtEth, fmtSpan } from "@/lib/format";
import { fmtUsd, useEthUsd, usdFromWei } from "@/lib/usd";
import { useLaunchpadConfig, type Listing } from "@/lib/hooks";
import type { Day } from "@/lib/scans";
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
 * there beside the trades.
 *
 * Both of those lead with the last twenty-four hours and put the lifetime figure in the
 * sub-line, because the two answer different questions and only one of them is news. "Is
 * this market busy *now*" is what somebody looking at a market page is asking, and a
 * cumulative total cannot answer it — it is the same number on a dead market as on a
 * live one, only larger. What the total is good for is scale, which is what a sub-line is
 * for. See `Day` in lib/scans.ts for how the window is kept.
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

  // The same money, flattened for the sub-line, where a dim ETH trailer inside 8.5px
  // uppercase mono would be two figures in a space that fits one.
  const money = (wei: bigint) =>
    ethUsd ? fmtUsd(usdFromWei(wei, ethUsd)) : `${fmtEth(wei)} ETH`;

  // The market list is capped at its newest page, so past that the cap and the
  // counts describe a subset. Say which subset rather than presenting a partial
  // sum as the whole market — the volume scan and the curve balance are unaffected
  // (one reads every log, the other is the contract's own counter).
  const clipped = tokenCount > BigInt(total);

  // The fallback span, for the one chain that gets no window: how far back the scan has
  // reached, in hours if the chain says how long a block takes and in blocks if it does
  // not. Anvil is the only chain that does not.
  const reach = !volume
    ? ""
    : volume.allTime
      ? "all time"
      : seconds !== undefined
        ? fmtSpan(seconds)
        : `${volume.blocks.toLocaleString()} blocks`;

  // Built once per card and read twice, because the failure states are shared and the
  // window is not: two copies of this would be two places for the wording to drift.
  const note = (lifetime: bigint, windowed: bigint) =>
    error
      ? "this RPC would not answer"
      : !volume
        ? "sounding…"
        : !volume.day
          ? reach
          : subLine(volume.day, volume.allTime, lifetime, windowed, money);

  const day = volume?.day;

  return (
    <dl className="stats">
      <div className="stat">
        <dt>Volume</dt>
        <dd>{day ? usdEth(day.eth) : volume ? usdEth(volume.eth) : "—"}</dd>
        <span className="stat-sub">
          {note(volume?.eth ?? 0n, day?.eth ?? 0n)}
        </span>
      </div>

      <div className="stat">
        <dt>Fees</dt>
        <dd>
          {day
            ? usdEth(day.fees.total)
            : volume
              ? usdEth(volume.fees.total)
              : "—"}
        </dd>
        <span className="stat-sub">
          {note(volume?.fees.total ?? 0n, day?.fees.total ?? 0n)}
        </span>
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

/**
 * The window the figure above covers, and the lifetime figure behind it.
 *
 * Three cases, and the third is what earns this a function rather than a template
 * string:
 *
 *  - The scan has not reached the launchpad's first block yet, so there is no lifetime
 *    figure to put here. The day itself is whole regardless — the window is near the
 *    head and the scan counts from the head down — so it says only how long it covers.
 *  - It has, and the two figures agree, which is every market younger than a day. "$0
 *    all time" beside $0 is a figure repeated to say nothing; the longer window is the
 *    truer label, so it takes the line alone.
 *  - It has, and they differ. Both, window first, since the window is the figure in the
 *    card.
 *
 * `fmtSpan` rather than a literal "24hrs": an instance still reaching backwards has less
 * than a day of blocks behind it, and seven hours is a fine thing to show and a bad thing
 * to call a day. The route says what it covers and this prints it.
 */
function subLine(
  day: Day,
  allTime: boolean,
  lifetime: bigint,
  windowed: bigint,
  money: (wei: bigint) => string,
): string {
  const span = fmtSpan(day.seconds);
  if (!allTime) return span;
  if (windowed === lifetime) return "all time";
  return `${span} · ${money(lifetime)} all time`;
}
