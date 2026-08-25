"use client";

import { useParams } from "next/navigation";
import { useMemo } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount, useChainId } from "wagmi";
import { Masthead, NotDeployed, NotFound } from "@/components/Chrome";
import { PoolPanel } from "@/components/PoolPanel";
import { PriceChart } from "@/components/PriceChart";
import { TokenArt } from "@/components/TokenArt";
import { TradeHistory } from "@/components/TradeHistory";
import { TradePanel } from "@/components/TradePanel";
import { CURVE, LP_BURN_ADDRESS } from "@/lib/contracts";
import { chainById } from "@/lib/chains";
import {
  depthFromProgress,
  fmtAge,
  fmtEth,
  fmtPriceGwei,
  fmtTokens,
  shortAddr,
} from "@/lib/format";
import { useLaunchpad, useTokenDetail } from "@/lib/hooks";
import { useTokenMeta } from "@/lib/metadata";
import { useTradeFeed } from "@/lib/trades";
import { fmtUsd, fmtUsdPrice, useEthUsd, usdFromWei } from "@/lib/usd";

export default function TokenPage() {
  const params = useParams<{ address: string }>();
  const raw = typeof params?.address === "string" ? params.address : "";
  const token: Address | null = isAddress(raw) ? getAddress(raw) : null;

  const { configured } = useLaunchpad();
  const chainId = useChainId();
  const { address: account } = useAccount();
  const detail = useTokenDetail(token ?? undefined, account);
  const {
    pool,
    pair,
    name,
    symbol,
    metadataURI,
    balance,
    allowance,
    priceE18,
    marketCap,
    progress,
    fromPool,
    isLoading,
    refetch,
  } = detail;

  // The chart and the trade list are the same history seen twice, so it is read
  // once here and handed to both — see lib/trades.ts.
  const feed = useTradeFeed(token ?? undefined, !!pool?.graduated);
  const { url: metaUrl, meta } = useTokenMeta(metadataURI);

  const depth = useMemo(() => depthFromProgress(progress), [progress]);
  const explorer = chainById(chainId)?.blockExplorers?.default.url;
  const ethUsd = useEthUsd();

  if (!token) {
    return (
      <div className="shell">
        <Masthead />
        <NotFound title="That is not an address.">
          <p className="note">
            This page needs a token address, and the one in the link is not one.
          </p>
        </NotFound>
      </div>
    );
  }

  return (
    <div className="shell" style={{ ["--t" as string]: depth.toFixed(3) }}>
      <Masthead />

      {!configured ? (
        <NotDeployed />
      ) : isLoading && !pool ? (
        <div className="empty">Sounding…</div>
      ) : !pool || !pool.exists ? (
        <NotFound title="No launch at this address.">
          <p className="note">
            <span className="addr">{shortAddr(token)}</span> has no launch on{" "}
            <b>{chainById(chainId)?.name ?? "this chain"}</b>. It may be on
            another network — check the one in the masthead.
          </p>
        </NotFound>
      ) : (
        <div className="stage">
          <div className="stack">
            {meta?.banner && (
              <div className="up-banner-hero">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={meta.banner} alt="" />
              </div>
            )}
            <div className="specimen-head">
              <TokenArt
                token={token}
                symbol={symbol}
                uri={metadataURI}
                size={84}
              />
              <div style={{ minWidth: 0 }}>
                <h1 className="title">{name || "—"}</h1>
                <div
                  className="row-sub"
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <span>{symbol}</span>
                  <span>·</span>
                  <span>launched {fmtAge(pool.createdAt)} ago</span>
                  <span>·</span>
                  {explorer ? (
                    <a
                      href={`${explorer}/address/${token}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(token)}
                    </a>
                  ) : (
                    <span>{shortAddr(token)}</span>
                  )}
                  {pool.graduated && (
                    <>
                      <span>·</span>
                      <span className="badge grad">graduated</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {(meta?.website || meta?.twitter || meta?.telegram || meta?.discord) && (
              <div className="up-links">
                {meta?.website && (
                  <a href={meta.website} target="_blank" rel="noreferrer">
                    Website ↗
                  </a>
                )}
                {meta?.twitter && (
                  <a href={meta.twitter} target="_blank" rel="noreferrer">
                    X ↗
                  </a>
                )}
                {meta?.telegram && (
                  <a href={meta.telegram} target="_blank" rel="noreferrer">
                    Telegram ↗
                  </a>
                )}
                {meta?.discord && (
                  <a href={meta.discord} target="_blank" rel="noreferrer">
                    Discord ↗
                  </a>
                )}
              </div>
            )}

            <div className="hero-price">
              {ethUsd
                ? fmtUsdPrice(usdFromWei(priceE18, ethUsd))
                : fmtPriceGwei(priceE18)}
              <span>
                {ethUsd ? (
                  <>
                    per {symbol || "token"} · {fmtPriceGwei(priceE18)} gwei
                  </>
                ) : (
                  <>gwei per {symbol || "token"}</>
                )}
                {fromPool && " · in the pool"}
              </span>
            </div>

            <div>
              <div className="depth">
                <i style={{ width: `${Math.min(100, progress / 100)}%` }} />
              </div>
              <div className="depth-cap">
                {/* The launchpad zeroes `realEthRaised` when it graduates — the
                    ETH is gone, into the pool — so reading the counter back here
                    would print "0 / 4 ETH raised" beside 100%. */}
                <span>
                  {pool.graduated
                    ? `graduated at ${fmtEth(CURVE.graduationEth)} ETH`
                    : `${fmtEth(pool.realEthRaised)} / ${fmtEth(CURVE.graduationEth)} ETH raised`}
                </span>
                <span className={progress >= 10_000 ? "gold" : ""}>
                  {(progress / 100).toFixed(1)}%
                </span>
              </div>
            </div>

            <PriceChart
              symbol={symbol || "token"}
              pool={pool}
              pair={pair}
              priceE18={priceE18}
              feed={feed}
            />

            <TradeHistory symbol={symbol || "tokens"} feed={feed} />

            <div className="panel">
              <div className="panel-head">
                <span>Sounding</span>
                <span className="dim">live</span>
              </div>
              <dl>
                <div className="r-row">
                  <dt>Market cap</dt>
                  <dd>
                    {ethUsd ? (
                      <>
                        {fmtUsd(usdFromWei(marketCap, ethUsd))}{" "}
                        <span className="dim">· {fmtEth(marketCap, 4)} ETH</span>
                      </>
                    ) : (
                      <>{fmtEth(marketCap, 4)} ETH</>
                    )}
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Sold on the curve</dt>
                  <dd>
                    {fmtTokens(pool.tokensSold)}{" "}
                    <span className="dim">
                      / {fmtTokens(CURVE.curveSupply)}
                    </span>
                  </dd>
                </div>
                {/* The curve's reserves stop moving at graduation and are never
                    written again, so showing them past that point states a price
                    no trade can change. Past graduation this row follows the
                    pool instead — the only liquidity that still exists. */}
                {pool.graduated ? (
                  <div className="r-row">
                    <dt>Pool liquidity</dt>
                    <dd>
                      {pair
                        ? `${fmtEth(pair.ethReserve, 4)} ETH / ${fmtTokens(pair.tokenReserve)}`
                        : "—"}
                    </dd>
                  </div>
                ) : (
                  <div className="r-row">
                    <dt>Curve reserves</dt>
                    <dd>
                      {fmtEth(pool.ethReserve, 4)} ETH /{" "}
                      {fmtTokens(pool.tokenReserve)}
                    </dd>
                  </div>
                )}
                <div className="r-row">
                  <dt>Creator</dt>
                  <dd>{shortAddr(pool.creator)}</dd>
                </div>
                {metadataURI && (
                  <div className="r-row">
                    <dt>Metadata</dt>
                    {/* Was the raw URI, ellipsised — a string nobody can use.
                        Anything a browser can follow is a link now, and a URI
                        that resolves to nothing says so instead of implying that
                        art exists somewhere. */}
                    <dd className="ellipsis" title={metadataURI}>
                      {metaUrl ? (
                        <a
                          className="link"
                          href={metaUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {meta?.name ?? "open"} ↗
                        </a>
                      ) : (
                        <span className="dim">not resolvable</span>
                      )}
                    </dd>
                  </div>
                )}
                <div className="r-row">
                  <dt>Your balance</dt>
                  <dd className={balance > 0n ? "gold" : ""}>
                    {fmtTokens(balance)} {symbol}
                  </dd>
                </div>
              </dl>

              {meta?.description && (
                <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                  {meta.description.slice(0, 320)}
                </p>
              )}
            </div>
          </div>

          <aside className="stack">
            {pool.graduated ? (
              <PoolPanel token={token} symbol={symbol || "tokens"} />
            ) : (
              <TradePanel
                token={token}
                symbol={symbol || "tokens"}
                pool={pool}
                balance={balance}
                allowance={allowance}
                onDone={refetch}
              />
            )}

            <div className="panel">
              <div className="panel-head">
                <span>{pool.graduated ? "After graduation" : "Before graduation"}</span>
              </div>
              {pool.graduated ? (
                <>
                  <p className="note" style={{ fontSize: 12.5 }}>
                    The curve is closed permanently. All remaining ETH and the{" "}
                    {fmtTokens(CURVE.lpSupply)} tokens held back for this moment
                    were deposited into a pool on our own DEX, and the LP tokens
                    were sent to {shortAddr(LP_BURN_ADDRESS)} — nobody can pull
                    that liquidity out, including us.
                  </p>
                  <p className="note" style={{ fontSize: 12.5 }}>
                    Swaps now pay <b>0.30%</b> to the pool instead of the
                    launchpad&apos;s curve fee.
                  </p>
                </>
              ) : (
                <>
                  <p className="note" style={{ fontSize: 12.5 }}>
                    Trades run against a constant-product curve priced off a
                    virtual {fmtEth(CURVE.virtualEth)} ETH reserve — no seed
                    liquidity, and no way for the creator to withdraw a reserve
                    that does not exist.
                  </p>
                  <p className="note" style={{ fontSize: 12.5 }}>
                    At <b>{fmtEth(CURVE.graduationEth)} ETH</b> raised the curve
                    closes and liquidity moves to a pool with the{" "}
                    <b>LP tokens burned</b>. The buy that crosses the line is
                    trimmed to land exactly on it, and the remainder is refunded
                    in the same transaction.
                  </p>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
