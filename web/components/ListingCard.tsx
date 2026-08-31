"use client";

import Link from "next/link";
import { DayChange } from "@/components/DayChange";
import { TokenArt } from "@/components/TokenArt";
import { CURVE } from "@/lib/contracts";
import type { Listing } from "@/lib/hooks";
import { fmtAge, fmtEth, fmtPriceGwei } from "@/lib/format";
import { fmtUsd, fmtUsdPrice, useEthUsd, usdFromWei } from "@/lib/usd";

/**
 * One launch as a card, for the market's grid view.
 *
 * The same specimen the {@link ListingRow} shows as a table row, reflowed into a
 * vertical card — art and identity on top, price and market cap along the foot,
 * the depth/graduation bar pinned to the bottom so the bars line up across a row
 * even when a name wraps. It deliberately reuses the row's type and depth-bar
 * classes (`row-name`, `row-sub`, `num`, `chg`, `depth`, `badge`) so the two views
 * can never drift apart; only the layout differs.
 *
 * Where that difference shows inside a shared class is the price change, which sits
 * inline after the price here and on its own line in the row: a column of prices has
 * to stay tabular, and a variable-width suffix would break the alignment `num` exists
 * for. A card has nothing to line up against.
 *
 * The row stays the shape for /profile and the market's list view — a grid is for
 * scanning a wall of launches at scale, a row for reading a short, known list.
 */
export function ListingCard({ listing }: { listing: Listing }) {
  const {
    token,
    name,
    symbol,
    metadataURI,
    pool,
    priceE18,
    marketCap,
    progress,
    fromPool,
  } = listing;
  const pct = (progress / 100).toFixed(1);
  const ethUsd = useEthUsd();

  return (
    <Link href={`/token/${token}`} className="card">
      <div className="card-head">
        <TokenArt token={token} symbol={symbol} uri={metadataURI} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row-name">{name}</div>
          <div className="row-sub">
            {symbol} · {fmtAge(pool.createdAt)} ago
          </div>
        </div>
        {pool.graduated && <span className="badge grad">graduated</span>}
      </div>

      <div className="card-foot">
        <div className="card-nums">
          <div className="num at-start">
            <small>{fromPool ? "Pool price" : "Price"}</small>
            {ethUsd ? (
              fmtUsdPrice(usdFromWei(priceE18, ethUsd))
            ) : (
              <>
                {fmtPriceGwei(priceE18)} <span className="dim">gwei</span>
              </>
            )}
            <DayChange token={token} priceE18={priceE18} />
          </div>
          <div className="num">
            <small>Market cap</small>
            {ethUsd ? (
              fmtUsd(usdFromWei(marketCap, ethUsd))
            ) : (
              <>
                {fmtEth(marketCap)} <span className="dim">ETH</span>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="depth">
            <i style={{ width: `${Math.min(100, progress / 100)}%` }} />
          </div>
          <div className="depth-cap">
            <span>
              {pool.graduated
                ? `graduated at ${fmtEth(CURVE.graduationEth)} ETH`
                : `${fmtEth(pool.realEthRaised)} / ${fmtEth(CURVE.graduationEth)} ETH`}
            </span>
            <span className={progress >= 10_000 ? "gold" : ""}>{pct}%</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
