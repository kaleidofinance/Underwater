"use client";

import Link from "next/link";
import { TokenArt } from "@/components/TokenArt";
import { CURVE } from "@/lib/contracts";
import type { Listing } from "@/lib/hooks";
import { fmtAge, fmtEth, fmtPriceGwei } from "@/lib/format";
import { fmtUsd, fmtUsdPrice, useEthUsd, usdFromWei } from "@/lib/usd";

/**
 * One launch as a table row.
 *
 * The market list and a wallet's own launches render the exact same shape, so it
 * lives here rather than being copied into both. `n` is the 1-based position in
 * whatever list is showing it. The five children line up with the `.row` grid in
 * globals.css: index, identity, price, market cap, progress.
 */
export function ListingRow({ listing, n }: { listing: Listing; n: number }) {
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
    <Link href={`/token/${token}`} className="row">
      <div className="row-n">{String(n).padStart(2, "0")}</div>

      <div className="row-id">
        <TokenArt token={token} symbol={symbol} uri={metadataURI} size={34} />
        <div style={{ minWidth: 0 }}>
          <div className="row-name">{name}</div>
          <div className="row-sub">
            {symbol} · {fmtAge(pool.createdAt)} ago
            {pool.graduated && (
              <>
                {" · "}
                <span className="badge grad">graduated</span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="num">
        <small>{fromPool ? "Pool price" : "Price"}</small>
        {ethUsd ? (
          fmtUsdPrice(usdFromWei(priceE18, ethUsd))
        ) : (
          <>
            {fmtPriceGwei(priceE18)} <span className="dim">gwei</span>
          </>
        )}
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
    </Link>
  );
}
