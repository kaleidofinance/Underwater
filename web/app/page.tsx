"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { MarketStats } from "@/components/MarketStats";
import { Seg } from "@/components/Seg";
import { ListingRow } from "@/components/ListingRow";
import { useLaunchpad, useListings } from "@/lib/hooks";
import { depthFromProgress } from "@/lib/format";

type Sort = "new" | "progress" | "cap";
/** Where a launch is in its life: still on the curve, or trading in a pool. */
type Phase = "all" | "curve" | "grad";

const PER_PAGE = 12;

export default function MarketPage() {
  const { configured } = useLaunchpad();
  const { listings, pairs, isLoading, isEmpty } = useListings();

  const [sort, setSort] = useState<Sort>("new");
  const [phase, setPhase] = useState<Phase>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const kept = listings.filter((l) => {
      if (phase === "curve" && l.pool.graduated) return false;
      if (phase === "grad" && !l.pool.graduated) return false;
      // Address included on purpose: a link someone pasted into chat is a
      // perfectly good way to look for a specimen.
      if (
        needle &&
        !`${l.name} ${l.symbol} ${l.token}`.toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
    // `listings` arrives newest-first, which is the "new" sort already.
    if (sort === "progress") kept.sort((a, b) => b.progress - a.progress);
    if (sort === "cap") kept.sort((a, b) => (b.marketCap > a.marketCap ? 1 : -1));
    return kept;
  }, [listings, phase, query, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  // Clamped rather than reset in an effect: the list shrinks under the cursor
  // whenever a filter narrows or the twelve-second poll drops a row.
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE);

  const change = <T,>(set: (v: T) => void) => (value: T) => {
    set(value);
    setPage(0);
  };

  // The whole page sits at the depth of its most-advanced launch, so a market
  // with something about to graduate is visibly closer to the surface.
  const depth = useMemo(
    () => depthFromProgress(Math.max(0, ...listings.map((l) => l.progress))),
    [listings],
  );

  return (
    <div className="shell" style={{ ["--t" as string]: depth.toFixed(3) }}>
      <Masthead />

      {!configured ? (
        <NotDeployed />
      ) : (
        <>
          <MarketStats listings={listings} pairs={pairs} />

          <div className="sec">
            <h1>Specimens — {listings.length} collected</h1>
          </div>

          {!isEmpty && (
            <div className="tools">
              <input
                type="text"
                value={query}
                onChange={(e) => change(setQuery)(e.target.value)}
                placeholder="Name, ticker or address"
                aria-label="Search specimens by name, ticker or address"
                spellCheck={false}
              />
              <Seg
                value={phase}
                onChange={change(setPhase)}
                label="Stage"
                options={[
                  ["all", "All"],
                  ["curve", "On the curve"],
                  ["grad", "Graduated"],
                ]}
              />
              <Seg
                value={sort}
                onChange={change(setSort)}
                label="Sort"
                options={[
                  ["new", "Newest"],
                  ["progress", "Closest to surface"],
                  ["cap", "Market cap"],
                ]}
              />
            </div>
          )}

          {isEmpty ? (
            <div className="empty">
              No launches yet — be the first
              <div style={{ marginTop: 18 }}>
                <Link href="/create" className="btn primary">
                  Launch a token
                </Link>
              </div>
            </div>
          ) : isLoading && listings.length === 0 ? (
            <div className="empty">Sounding…</div>
          ) : rows.length === 0 ? (
            <div className="empty">
              Nothing matches that
              <div style={{ marginTop: 18 }}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setPhase("all");
                    setPage(0);
                  }}
                >
                  Clear the filters
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                {shown.map((l, i) => (
                  <ListingRow
                    key={l.token}
                    listing={l}
                    n={at * PER_PAGE + i + 1}
                  />
                ))}
              </div>

              {rows.length > PER_PAGE && (
                <div className="pager">
                  <span>
                    {at * PER_PAGE + 1}–
                    {Math.min(rows.length, (at + 1) * PER_PAGE)} of {rows.length}
                    {rows.length !== listings.length &&
                      ` · ${listings.length} collected`}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      disabled={at === 0}
                      onClick={() => setPage(at - 1)}
                    >
                      ‹ Prev
                    </button>
                    <button
                      type="button"
                      disabled={at >= pages - 1}
                      onClick={() => setPage(at + 1)}
                    >
                      Next ›
                    </button>
                  </span>
                </div>
              )}
            </>
          )}

          <p className="note" style={{ marginTop: 34 }}>
            Every launch starts at <b>1 gwei</b> per token and graduates at{" "}
            <b>25 gwei</b> — a 25× move funded entirely by buyers, with no seed
            liquidity from the creator. At 4 ETH raised the curve closes forever
            and the liquidity moves to a real pool with the{" "}
            <b>LP tokens burned</b>.
          </p>
        </>
      )}
    </div>
  );
}

// The market row lives in components/ListingRow.tsx — a wallet's own launches
// on /profile render the identical shape, so it is shared rather than copied.
