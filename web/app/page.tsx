"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { MarketStats } from "@/components/MarketStats";
import { Seg } from "@/components/Seg";
import { ListingRow } from "@/components/ListingRow";
import { ListingCard } from "@/components/ListingCard";
import { useLaunchpad, useMarketPage, type MarketSort } from "@/lib/hooks";
import { MARKET_LIMIT } from "@/lib/market";
import { depthFromProgress } from "@/lib/format";

/** Where a launch is in its life: still on the curve, or trading in a pool. */
type Phase = "all" | "curve" | "grad";
/** Cards for scanning a wall of launches, or dense rows for a short known list. */
type View = "grid" | "list";

// A card packs more identity per screen than a row's sliver does, so the grid
// pages in larger runs — pagination already bounds the DOM either way.
const PER_PAGE: Record<View, number> = { grid: 24, list: 12 };
const VIEW_KEY = "underwater.market-view";

/**
 * The orderings, and which of them a browser can produce for itself.
 *
 * The first three are columns on every listing, so they work over whatever page arrived —
 * which is what this page did for all of its sorts until now, and what it still does on a
 * chain with no indexer behind it. The last two order rows the page was never sent, so
 * they are offered only when the route reports it can order the whole market. Hiding them
 * beats showing a control that silently hands back the newest launches.
 *
 * "Most traded" rather than "24h volume", because the figure behind it is the lifetime
 * counter — see `MARKET_SORTS` in lib/market.ts for why that is the one that exists.
 */
const SORTS: readonly (readonly [MarketSort, string])[] = [
  ["new", "Newest"],
  ["progress", "Closest to surface"],
  ["cap", "Market cap"],
  ["volume", "Most traded"],
  ["active", "Recently active"],
];
const LOCAL_SORTS: readonly MarketSort[] = ["new", "progress", "cap"];

/**
 * A page index meaning "the last one", resolved by the clamp on `at`.
 *
 * Stepping back into the previous hundred should land on its final page, and how many
 * pages that is depends on rows that have not arrived yet. So the intent is stored and
 * the clamp settles it when they do.
 */
const LAST_PAGE = Number.MAX_SAFE_INTEGER;

export default function MarketPage() {
  const { configured } = useLaunchpad();

  const [sort, setSort] = useState<MarketSort>("new");
  const [phase, setPhase] = useState<Phase>("all");
  const [query, setQuery] = useState("");
  /**
   * Position, as one value, because a page index only means something inside the hundred
   * it was chosen in. Kept together so the two can never be read half-updated — which
   * matters on the round trip after a step, where the previous hundred is still on screen.
   */
  const [cursor, setCursor] = useState({ at: 0, block: 0 });
  // Grid on the server and first paint, then adopt the saved choice after mount —
  // reading localStorage during render would diverge from the server HTML and
  // trip a hydration mismatch.
  const [view, setView] = useState<View>("grid");
  useEffect(() => {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "grid" || saved === "list") setView(saved);
  }, []);

  const perPage = PER_PAGE[view];

  // The route serves the newest hundred when it cannot page at all, so a cursor left
  // further in has nothing to point at. Snapping it back costs a line here and saves a
  // stranded pager if the indexer goes away under someone who had walked into the market.
  const { listings, tokenCount, offset, whole, isLoading, isEmpty } = useMarketPage(
    sort,
    cursor.block,
  );
  const block = whole ? cursor.block : 0;

  // Only the orderings that currently mean something, and the selection follows: an
  // option that stops being offered mid-session cannot stay lit over a list that is no
  // longer in that order.
  const options = whole ? SORTS : SORTS.filter(([key]) => LOCAL_SORTS.includes(key));
  const usable: MarketSort = options.some(([key]) => key === sort) ? sort : "new";

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
    // Only where the route could not order it. Once the ordering covers the whole market
    // the page arrives in it, and re-sorting a page of a larger ordering would make a
    // list that is neither what the label promises nor what the next page continues from.
    if (!whole) {
      if (usable === "progress") kept.sort((a, b) => b.progress - a.progress);
      if (usable === "cap") kept.sort((a, b) => (b.marketCap > a.marketCap ? 1 : -1));
    }
    return kept;
  }, [listings, phase, query, usable, whole]);

  const pages = Math.max(1, Math.ceil(rows.length / perPage));

  /**
   * The page on screen.
   *
   * Clamped rather than reset in an effect: the list shrinks under the cursor whenever a
   * filter narrows or the twelve-second poll drops a row. The two mismatch branches are
   * the round trip after a step, where `listings` is still the previous hundred and the
   * cursor already names the next one — showing the edge it was leaving from holds the
   * view still instead of flashing that hundred's first page on the way out.
   */
  const at =
    cursor.block === offset
      ? Math.min(cursor.at, pages - 1)
      : cursor.block > offset
        ? pages - 1
        : 0;

  const from = at * perPage;
  const to = Math.min(rows.length, from + perPage);
  const shown = rows.slice(from, from + perPage);

  const total = Number(tokenCount ?? 0n);
  const filtered = rows.length !== listings.length;

  // Search and stage stay client-side over the hundred that was fetched, so they turn
  // paging off rather than being pushed down as a `WHERE`: a filter that covers one page
  // cannot be counted against the whole market, and the pager says which it is counting.
  const walkable = whole && !filtered;
  const beyond = walkable && offset + MARKET_LIMIT < total;
  const absolute = walkable && total > MARKET_LIMIT;

  const goPrev = () => {
    if (at > 0) return setCursor({ at: at - 1, block });
    setCursor({ at: LAST_PAGE, block: Math.max(0, block - MARKET_LIMIT) });
  };
  const goNext = () => {
    if (at < pages - 1) return setCursor({ at: at + 1, block });
    setCursor({ at: 0, block: block + MARKET_LIMIT });
  };

  // A different ordering is a different market, so a position in the old one names
  // nothing — page and hundred both go back to the start.
  const changeSort = (value: MarketSort) => {
    setSort(value);
    setCursor({ at: 0, block: 0 });
  };

  // Search and stage narrow the hundred already on screen, so they keep it and only the
  // page index resets. Sending someone back to the first hundred to filter would lose the
  // place they chose, and the count would then describe a page they never asked for.
  const narrow = <T,>(set: (v: T) => void) => (value: T) => {
    set(value);
    setCursor({ at: 0, block });
  };

  // View is sticky across visits, so it persists. It changes how many rows a page
  // holds but not which hundred they come from, so only the page index resets.
  const changeView = (v: View) => {
    setView(v);
    setCursor({ at: 0, block });
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
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
          <MarketStats listings={listings} />

          <div className="sec">
            {/* The market's own size, not the page's — and nothing at all until it is
                known, because "0 collected" is a wrong answer to hold up for a round
                trip. */}
            <h1>
              Specimens
              {tokenCount === undefined
                ? ""
                : ` — ${tokenCount.toLocaleString()} collected`}
            </h1>
          </div>

          {!isEmpty && (
            <div className="tools">
              <input
                type="text"
                value={query}
                onChange={(e) => narrow(setQuery)(e.target.value)}
                placeholder="Name, ticker or address"
                aria-label="Search specimens by name, ticker or address"
                spellCheck={false}
              />
              <Seg
                value={phase}
                onChange={narrow(setPhase)}
                label="Stage"
                options={[
                  ["all", "All"],
                  ["curve", "On the curve"],
                  ["grad", "Graduated"],
                ]}
              />
              <Seg
                value={usable}
                onChange={changeSort}
                label="Sort"
                options={options}
              />
              <Seg
                value={view}
                onChange={changeView}
                label="View"
                options={[
                  ["grid", "Grid"],
                  ["list", "List"],
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
                    setCursor({ at: 0, block });
                  }}
                >
                  Clear the filters
                </button>
              </div>
            </div>
          ) : (
            <>
              {view === "grid" ? (
                <div className="card-grid">
                  {shown.map((l) => (
                    <ListingCard key={l.token} listing={l} />
                  ))}
                </div>
              ) : (
                <div>
                  {shown.map((l, i) => (
                    <ListingRow
                      key={l.token}
                      listing={l}
                      n={(absolute ? offset : 0) + from + i + 1}
                    />
                  ))}
                </div>
              )}

              {(rows.length > perPage || beyond || offset > 0) && (
                <div className="pager">
                  <span>
                    {absolute
                      ? `${offset + from + 1}–${offset + to} of ${total.toLocaleString()}`
                      : `${from + 1}–${to} of ${rows.length}${
                          filtered
                            ? total > MARKET_LIMIT
                              ? " matching on this page"
                              : " matching"
                            : ""
                        }`}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      disabled={at === 0 && offset === 0}
                      onClick={goPrev}
                    >
                      ‹ Prev
                    </button>
                    <button
                      type="button"
                      disabled={at >= pages - 1 && !beyond}
                      onClick={goNext}
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
