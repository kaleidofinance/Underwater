"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Seg } from "@/components/Seg";
import { ZecTokenCard } from "@/components/zec/ZecBits";
import { fmtZec } from "@/lib/zec/format";
import { useZecReserves, useZecStats, useZecTokens } from "@/lib/zec/hooks";

type Sort = "active" | "new" | "mcap";

export default function ZecMarket() {
  const tokens = useZecTokens();
  const stats = useZecStats();
  const reserves = useZecReserves();
  const [sort, setSort] = useState<Sort>("active");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (tokens.data ?? []).filter(
      (t) => !q || t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q),
    );
    if (sort === "new") return [...list].sort((a, b) => b.createdAt - a.createdAt);
    if (sort === "mcap") return [...list].sort((a, b) => (BigInt(b.marketCap) > BigInt(a.marketCap) ? 1 : -1));
    return list; // the API already orders by latest activity
  }, [tokens.data, sort, query]);

  const drift = reserves.data ? BigInt(reserves.data.drift) : null;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="k">Tokens</div>
          <div className="v">{stats.data?.tokens ?? "—"}</div>
          <div className="stat-sub">{stats.data ? `${stats.data.graduated} graduated` : ""}</div>
        </div>
        <div className="stat">
          <div className="k">24h volume</div>
          <div className="v">{stats.data ? `${fmtZec(stats.data.volume24h, 2)} ZEC` : "—"}</div>
        </div>
        <div className="stat">
          <div className="k">Held for users</div>
          <div className="v">{stats.data ? `${fmtZec(stats.data.liabilities, 2)} ZEC` : "—"}</div>
          <div className="stat-sub">
            {drift === null ? "checking reserves…" : drift >= 0n ? "✓ fully backed by the treasury" : "✗ reserves short — investigating"}
          </div>
        </div>
      </div>

      <div className="sec">
        <h1>Launches on Zcash</h1>
      </div>

      {tokens.error ? (
        <div className="empty">
          Can't reach the ZEC engine right now.
          <div className="dim" style={{ marginTop: 8 }}>
            {(tokens.error as Error).message}
          </div>
        </div>
      ) : tokens.isLoading ? (
        <div className="empty">Sounding…</div>
      ) : (tokens.data ?? []).length === 0 ? (
        <div className="empty">
          No launches yet — be the first
          <div style={{ marginTop: 18 }}>
            <Link href="/create" className="btn primary">
              Launch a token
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="tools">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or ticker"
              aria-label="Search by name or ticker"
              spellCheck={false}
            />
            <Seg<Sort>
              value={sort}
              onChange={setSort}
              label="Sort"
              options={[
                ["active", "Active"],
                ["new", "New"],
                ["mcap", "Market cap"],
              ]}
            />
          </div>
          {rows.length === 0 ? (
            <div className="empty">Nothing matches that</div>
          ) : (
            <div className="card-grid">
              {rows.map((t) => (
                <ZecTokenCard key={t.id} token={t} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
