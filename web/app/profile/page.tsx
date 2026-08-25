"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { ListingRow } from "@/components/ListingRow";
import { Seg } from "@/components/Seg";
import { TokenArt } from "@/components/TokenArt";
import { useLaunchpad, type Listing } from "@/lib/hooks";
import { useProfile, type Holding } from "@/lib/profile";
import { depthFromProgress, fmtEth, fmtTokens, shortAddr } from "@/lib/format";

type Tab = "launches" | "positions" | "rewards" | "plates";

export default function ProfilePage() {
  const { configured } = useLaunchpad();
  const {
    address,
    connected,
    launches,
    holdings,
    portfolioValue,
    raisedByYou,
    isLoading,
    capped,
    window: scanned,
  } = useProfile();

  const [tab, setTab] = useState<Tab>("launches");

  // Like the market, the page sits at the depth of its most-advanced launch or
  // position — an active wallet surfaces into brighter water.
  const depth = useMemo(() => {
    const progresses = [
      ...launches.map((l) => l.progress),
      ...holdings.map((h) => h.progress),
    ];
    return depthFromProgress(progresses.length ? Math.max(...progresses) : 0);
  }, [launches, holdings]);

  return (
    <div className="shell" style={{ ["--t" as string]: depth.toFixed(3) }}>
      <Masthead />

      {!configured ? (
        <NotDeployed>
          Your launches, positions and rewards live here once the launchpad is
          live on this network. Switch networks in the masthead.
        </NotDeployed>
      ) : !connected ? (
        <>
          <div className="sec">
            <h1>Your profile</h1>
          </div>
          <div className="empty">
            Connect a wallet to see your launches, positions and rewards
            <div
              className="note"
              style={{ marginTop: 14, textTransform: "none", letterSpacing: 0 }}
            >
              Use the <b>Connect wallet</b> button in the masthead above.
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="sec">
            <h1>Your profile</h1>
            <span
              style={{ display: "flex", gap: 16, alignItems: "baseline" }}
            >
              <Link href="/swap" className="link prof-addr">
                Swap →
              </Link>
              <span className="prof-addr">
                {address ? shortAddr(address) : ""}
              </span>
            </span>
          </div>

          <div className="tools">
            <Seg
              value={tab}
              onChange={setTab}
              label="Profile section"
              options={[
                ["launches", `Launches${launches.length ? ` · ${launches.length}` : ""}`],
                ["positions", `Positions${holdings.length ? ` · ${holdings.length}` : ""}`],
                ["rewards", "Rewards"],
                ["plates", "Plates"],
              ]}
            />
          </div>

          {tab === "launches" && (
            <LaunchesTab launches={launches} loading={isLoading} capped={capped} scanned={scanned} />
          )}
          {tab === "positions" && (
            <PositionsTab
              holdings={holdings}
              portfolioValue={portfolioValue}
              loading={isLoading}
              capped={capped}
              scanned={scanned}
            />
          )}
          {tab === "rewards" && (
            <RewardsTab
              launches={launches.length}
              positions={holdings.length}
              raised={raisedByYou}
              portfolio={portfolioValue}
            />
          )}
          {tab === "plates" && <PlatesTab />}
        </>
      )}
    </div>
  );
}

/** A "…N launches back" caveat, shown only when the scan window clipped some. */
function CapNote({ capped, scanned }: { capped: boolean; scanned: number }) {
  if (!capped) return null;
  return (
    <p className="prof-tab-note">
      Based on the {scanned} most recent launches — older ones aren&apos;t
      scanned yet.
    </p>
  );
}

function LaunchesTab({
  launches,
  loading,
  capped,
  scanned,
}: {
  launches: Listing[];
  loading: boolean;
  capped: boolean;
  scanned: number;
}) {
  if (loading && launches.length === 0) return <div className="empty">Sounding…</div>;
  if (launches.length === 0) {
    return (
      <div className="empty">
        You haven&apos;t launched anything yet
        <div style={{ marginTop: 18 }}>
          <Link href="/create" className="btn primary">
            Launch a token
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div>
      {launches.map((l, i) => (
        <ListingRow key={l.token} listing={l} n={i + 1} />
      ))}
      <CapNote capped={capped} scanned={scanned} />
    </div>
  );
}

function PositionsTab({
  holdings,
  portfolioValue,
  loading,
  capped,
  scanned,
}: {
  holdings: Holding[];
  portfolioValue: bigint;
  loading: boolean;
  capped: boolean;
  scanned: number;
}) {
  if (loading && holdings.length === 0) return <div className="empty">Sounding…</div>;
  if (holdings.length === 0) {
    return (
      <div className="empty">
        No positions yet
        <div style={{ marginTop: 18 }}>
          <Link href="/" className="btn primary">
            Browse the market
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div>
      {holdings.map((h, i) => (
        <HoldingRow key={h.token} holding={h} n={i + 1} />
      ))}
      <div className="sec" style={{ marginTop: 16 }}>
        <span>Portfolio</span>
        <span className="prof-addr">{fmtEth(portfolioValue)} ETH</span>
      </div>
      <CapNote capped={capped} scanned={scanned} />
    </div>
  );
}

/** A held token as a `.row` — index, identity, balance, value, supply share. */
function HoldingRow({ holding, n }: { holding: Holding; n: number }) {
  const { token, name, symbol, metadataURI, pool, balance, value, shareBps } = holding;
  const share =
    shareBps === 0 ? "<0.01" : (shareBps / 100).toFixed(shareBps >= 100 ? 1 : 2);

  return (
    <Link href={`/token/${token}`} className="row">
      <div className="row-n">{String(n).padStart(2, "0")}</div>

      <div className="row-id">
        <TokenArt token={token} symbol={symbol} uri={metadataURI} size={34} />
        <div style={{ minWidth: 0 }}>
          <div className="row-name">{name}</div>
          <div className="row-sub">
            {symbol}
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
        <small>Balance</small>
        {fmtTokens(balance)} <span className="dim">{symbol}</span>
      </div>

      <div className="num">
        <small>Value</small>
        {fmtEth(value)} <span className="dim">ETH</span>
      </div>

      <div className="num">
        <small>Supply</small>
        {share}
        <span className="dim">%</span>
      </div>
    </Link>
  );
}

function RewardsTab({
  launches,
  positions,
  raised,
  portfolio,
}: {
  launches: number;
  positions: number;
  raised: bigint;
  portfolio: bigint;
}) {
  return (
    <div className="prof-rewards">
      <p
        className="note"
        style={{ textTransform: "none", letterSpacing: 0, maxWidth: "64ch" }}
      >
        <b>$WATER is coming.</b> The protocol token will be shared with the people
        who make the market — token <b>creators</b>, <b>liquidity providers</b>{" "}
        and <b>traders</b>. There is nothing to claim yet; the activity below is
        what a distribution would draw on.
      </p>

      <div className="reward-grid">
        <div className="reward-stat">
          <div className="k">Launches created</div>
          <div className="v">{launches}</div>
        </div>
        <div className="reward-stat">
          <div className="k">Raised across them</div>
          <div className="v">{fmtEth(raised)} ETH</div>
        </div>
        <div className="reward-stat">
          <div className="k">Positions held</div>
          <div className="v">{positions}</div>
        </div>
        <div className="reward-stat">
          <div className="k">Portfolio value</div>
          <div className="v">{fmtEth(portfolio)} ETH</div>
        </div>
      </div>

      <button type="button" className="claim-btn" disabled>
        Claim $WATER — opens at launch
      </button>
      <p className="field-note">
        Trading volume and liquidity-provision tracking arrive with the token.
      </p>
    </div>
  );
}

function PlatesTab() {
  return (
    <div className="empty">
      Your plates will appear here
      <div
        className="note"
        style={{ marginTop: 14, textTransform: "none", letterSpacing: 0 }}
      >
        The 2222-plate collection is a separate contract — this tab is being wired
        up. For now, view the <Link href="/plates">Plates</Link> page and mint
        from there.
      </div>
    </div>
  );
}
