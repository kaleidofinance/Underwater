"use client";

import { useMemo, useState } from "react";
import { useAccount, useChainId } from "wagmi";
import { Seg } from "@/components/Seg";
import { chainById } from "@/lib/chains";
import { fmtAge, fmtEth, fmtTokens, shortAddr } from "@/lib/format";
import {
  filterTrades,
  isFiltered,
  NO_FILTER,
  type TradeFeed,
  type TradeFilter,
} from "@/lib/trades";

/**
 * The order flow, live, under the chart.
 *
 * Same data as the chart and the same filters over it — see `lib/trades.ts` for
 * why the feed is a hook the page owns rather than something either component
 * fetches for itself. What this adds is the ability to find one trade in it: by
 * side, by venue, by whose it was, or by a hash someone sent you.
 *
 * A trader's address is a button rather than a link, because on a page about one
 * token the useful thing to do with "who" is see the rest of what they did here,
 * not leave for an explorer. The timestamp is the link out to the transaction.
 */

const PER_PAGE = 12;

export function TradeHistory({
  symbol,
  feed,
}: {
  symbol: string;
  feed: TradeFeed;
}) {
  const chainId = useChainId();
  const { address: account } = useAccount();
  const explorer = chainById(chainId)?.blockExplorers?.default.url;

  const [filter, setFilter] = useState<TradeFilter>(NO_FILTER);
  const [page, setPage] = useState(0);

  // Any change to what is being looked for starts again at the top: page 3 of
  // the old result set means nothing in the new one.
  const set = (patch: Partial<TradeFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  const rows = useMemo(() => filterTrades(feed.trades, filter), [feed.trades, filter]);

  // Only worth naming the venue when the history actually spans two of them.
  const showVenue = feed.trades.some((r) => r.venue === "pool");
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  // Clamped rather than corrected in an effect: the list shrinks under the
  // cursor every time a filter narrows or a refetch drops a row off the tail.
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE);

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Recent trades</span>
        <span className="dim">
          {feed.complete
            ? "all of them"
            : `last ${feed.window.toLocaleString()} blocks`}
        </span>
      </div>

      <div className="tools">
        <input
          type="text"
          value={filter.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder="Address or transaction hash"
          aria-label="Search trades by address or transaction hash"
          spellCheck={false}
        />

        <Seg
          value={filter.side}
          onChange={(side) => set({ side })}
          label="Side"
          options={[
            ["all", "All"],
            ["buy", "Buys"],
            ["sell", "Sells"],
          ]}
        />

        {showVenue && (
          <Seg
            value={filter.venue}
            onChange={(venue) => set({ venue })}
            label="Venue"
            options={[
              ["all", "Both"],
              ["curve", "Curve"],
              ["pool", "Pool"],
            ]}
          />
        )}

        {account && (
          <button
            type="button"
            className="seg-one"
            data-active={!!filter.mine}
            onClick={() => set({ mine: filter.mine ? null : account })}
          >
            Mine
          </button>
        )}

        {isFiltered(filter) && (
          <button type="button" className="seg-one" onClick={() => set(NO_FILTER)}>
            Clear
          </button>
        )}
      </div>

      {feed.error ? (
        <p className="note" style={{ fontSize: 12.5 }}>
          This RPC would not serve the log range. Trades will still settle
          normally — only this list is unavailable.
        </p>
      ) : feed.isLoading && feed.trades.length === 0 ? (
        <div className="empty" style={{ padding: "24px 0" }}>
          Sounding…
        </div>
      ) : rows.length === 0 ? (
        <div className="empty" style={{ padding: "24px 0" }}>
          {feed.trades.length === 0
            ? "No trades in this window"
            : "Nothing matches that"}
        </div>
      ) : (
        <div className="trades">
          {shown.map((r) => {
            const age = r.timestamp === null ? "—" : `${fmtAge(r.timestamp)} ago`;
            return (
              <div className="trade" key={r.key}>
                <span
                  className="side"
                  style={{ color: r.isBuy ? "var(--goldleaf)" : "var(--sell)" }}
                >
                  {r.isBuy ? "Buy" : "Sell"}
                </span>
                <span>
                  {fmtEth(r.ethAmount, 5)} ETH{" "}
                  <span className="dim">
                    {r.isBuy ? "→" : "←"} {fmtTokens(r.tokenAmount)} {symbol}
                  </span>
                </span>
                <span className="dim">
                  {showVenue && `${r.venue} · `}
                  <button
                    type="button"
                    className="link"
                    title={`Only ${shortAddr(r.trader)}'s trades`}
                    onClick={() => set({ query: r.trader, mine: null })}
                  >
                    {shortAddr(r.trader)}
                  </button>
                  {" · "}
                  {explorer && r.txHash ? (
                    <a
                      className="link"
                      href={`${explorer}/tx/${r.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open this transaction"
                    >
                      {age}
                    </a>
                  ) : (
                    age
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {(rows.length > PER_PAGE || feed.canDeepen) && (
        <div className="pager">
          <span>
            {rows.length > 0 &&
              `${at * PER_PAGE + 1}–${Math.min(rows.length, (at + 1) * PER_PAGE)} of ${rows.length}`}
            {isFiltered(filter) && feed.trades.length !== rows.length &&
              ` · ${feed.trades.length} scanned`}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            {feed.canDeepen && (
              <button
                type="button"
                onClick={feed.deeper}
                title="Scan further back for older trades"
              >
                Scan deeper
              </button>
            )}
            <button type="button" disabled={at === 0} onClick={() => setPage(at - 1)}>
              ‹ Newer
            </button>
            <button
              type="button"
              disabled={at >= pages - 1}
              onClick={() => setPage(at + 1)}
            >
              Older ›
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
