"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { ListingRow } from "@/components/ListingRow";
import { PointsAdmin } from "@/components/PointsAdmin";
import { PointsTab } from "@/components/PointsTab";
import { Seg } from "@/components/Seg";
import { TokenArt } from "@/components/TokenArt";
import { useLaunchpad, type Listing } from "@/lib/hooks";
import { fmtPointsAmount } from "@/lib/points";
import { usePoints, usePointsOwner } from "@/lib/points-client";
import { useProfile, type Holding } from "@/lib/profile";
import { useProtocolFeeTo, useProtocolFees, type ProtocolPool } from "@/lib/protocol";
import { fmtUsd, useEthUsd, usdFromWei } from "@/lib/usd";
import { depthFromProgress, fmtEth, fmtTokens, shortAddr } from "@/lib/format";

/**
 * The sections of a profile.
 *
 * `points` is the visitor's own dashboard — balance, breakdown, history — and
 * `points-admin` is the owner console that used to hold that name. Renamed rather
 * than sharing one tab: the two have nothing in common but a contract, and a tab
 * whose contents depend on who is connected is a tab nobody can be pointed at.
 */
type Tab =
  | "launches"
  | "positions"
  | "rewards"
  | "points"
  | "plates"
  | "protocol"
  | "points-admin";

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

  // The protocol-fee readout is a treasury view, not something every visitor
  // should see: the tab exists only when the connected wallet is the fee
  // recipient (feeTo) itself.
  const feeTo = useProtocolFeeTo();
  const isProtocolOwner =
    connected && !!address && !!feeTo && address.toLowerCase() === feeTo.toLowerCase();

  // Same rule for the points console, asked of a different contract: uwPoints has
  // its own owner, which need not be feeTo. Hiding the tab is a courtesy — every
  // write in it reverts for anybody else — so the question is put to the chain
  // rather than to a list of addresses here.
  const { isOwner: isPointsOwner } = usePointsOwner();

  // If the wallet changes out from under a selected owner-only tab, fall back so
  // the Seg value never points at an option that is no longer shown.
  useEffect(() => {
    if (tab === "protocol" && !isProtocolOwner) setTab("launches");
    if (tab === "points-admin" && !isPointsOwner) setTab("launches");
  }, [tab, isProtocolOwner, isPointsOwner]);

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
                ["points", "Points"],
                ["plates", "Plates"],
                ...(isProtocolOwner
                  ? ([["protocol", "Protocol"]] as [Tab, string][])
                  : []),
                ...(isPointsOwner
                  ? ([["points-admin", "Points admin"]] as [Tab, string][])
                  : []),
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
              seePoints={() => setTab("points")}
            />
          )}
          {tab === "points" && <PointsTab />}
          {tab === "plates" && <PlatesTab />}
          {tab === "protocol" && isProtocolOwner && <ProtocolTab />}
          {tab === "points-admin" && isPointsOwner && <PointsAdmin />}
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

/**
 * What $WATER is, what this wallet has done, and the button that is not open yet.
 *
 * The balance and its breakdown used to lead this tab and have moved to Points, which
 * is where the history of them lives too — a total is worth more standing over the
 * events it was counted from than over a second grid of the same four numbers. What is
 * left is the pair of things Points cannot say: what the token is for, and this
 * wallet's activity in ETH, which no rate card prices.
 *
 * The balance is still one press away and the copy says so, because somebody who opens
 * Rewards is asking about their share and should not have to guess which tab holds it.
 */
function RewardsTab({
  launches,
  positions,
  raised,
  portfolio,
  seePoints,
}: {
  launches: number;
  positions: number;
  raised: bigint;
  portfolio: bigint;
  /// Switches the page to the Points tab. A button rather than a link: the tab is
  /// component state, not a route, so a `/profile#points` href would reload the page
  /// to land on the same one.
  seePoints: () => void;
}) {
  const { profile } = usePoints();

  return (
    <div className="prof-rewards">
      <p
        className="note"
        style={{ textTransform: "none", letterSpacing: 0 }}
      >
        <b>$WATER is coming.</b> The protocol token will be shared with the people
        who make the market — token <b>creators</b>, <b>liquidity providers</b>{" "}
        and <b>traders</b>. <b>uwPoints</b> are how that share is measured, and they
        are counted from what this wallet has already done on chain. There is nothing
        to claim yet.
      </p>

      {/* The balance as a line rather than the hero it is on Points: here it is a
          pointer at that tab, and two pages competing to be where a wallet reads its
          own total is how the two come to disagree. */}
      <div className="sec" style={{ marginTop: 22 }}>
        <span>$uwPoint</span>
        <button type="button" className="link prof-addr" onClick={seePoints}>
          {profile ? `${fmtPointsAmount(profile.points.total)} · balance and history →` : "Balance and history →"}
        </button>
      </div>

      <div className="sec">
        <span>Activity</span>
      </div>

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
        Points are recomputed from on-chain logs on every read, so a rate change
        re-prices what is already here. Redeeming them for $WATER will go through a
        published snapshot, the way the plates allowlist does.
      </p>
    </div>
  );
}

/**
 * Owner-only readout of the DEX protocol fee: what has accrued to `feeTo` across
 * every graduated pool, valued in ETH. Read-only — collecting is a deliberate
 * on-chain step (add then remove a little liquidity, to mint and redeem the
 * cut), run from a terminal rather than a button here.
 */
function ProtocolTab() {
  const { pools, totalEthValue, armedCount, graduatedCount, feeTo, isLoading } =
    useProtocolFees();
  const ethUsd = useEthUsd();

  return (
    <div className="prot">
      <div className="sec">
        <span>Protocol fees</span>
        <span className="prof-addr">feeTo {feeTo ? shortAddr(feeTo) : "off"}</span>
      </div>

      <p
        className="note"
        style={{ textTransform: "none", letterSpacing: 0 }}
      >
        The DEX takes <b>⅙ of every graduated pool&apos;s 0.3% swap fee</b> —
        about 0.05% of volume — paid as <b>LP tokens</b> to <b>feeTo</b>, not ETH.
        It accrues on liquidity events, so with base liquidity burned it sits{" "}
        <b>unminted</b> until a pool is poked; the totals below include that
        pending cut, valued at each pool&apos;s current price.
      </p>

      <div className="prot-total">
        <div className="k">
          Accrued across {graduatedCount} graduated pool
          {graduatedCount === 1 ? "" : "s"}
        </div>
        <div className="v">
          ≈ {fmtEth(totalEthValue)} ETH
          {ethUsd ? (
            <span className="prot-usd"> · {fmtUsd(usdFromWei(totalEthValue, ethUsd))}</span>
          ) : null}
        </div>
      </div>

      {isLoading && pools.length === 0 ? (
        <div className="empty">Sounding…</div>
      ) : graduatedCount === 0 ? (
        <div className="empty">
          No graduated pools yet
          <div
            className="note"
            style={{ marginTop: 14, textTransform: "none", letterSpacing: 0 }}
          >
            The protocol fee starts earning once a token graduates onto the DEX
            and trades.
          </div>
        </div>
      ) : (
        <div className="prot-pools">
          {pools.map((p, i) => (
            <ProtocolPoolRow key={p.pair} pool={p} n={i + 1} ethUsd={ethUsd} />
          ))}
        </div>
      )}

      <p className="field-note">
        {armedCount} of {pools.length} pool{pools.length === 1 ? "" : "s"} armed. A
        pool starts accruing at its first liquidity event after the fee was
        switched on — until then it reads ~0. Collect by adding then removing a
        little liquidity, which mints the cut as LP and redeems it; run from a
        terminal, since it moves the treasury.
      </p>
    </div>
  );
}

/** One graduated pool's accrued fee, as a `.row` matching the other tabs. */
function ProtocolPoolRow({
  pool,
  n,
  ethUsd,
}: {
  pool: ProtocolPool;
  n: number;
  ethUsd: number | null;
}) {
  const { token, name, symbol, metadataURI, realizedLp, pendingLp, ethValue, armed } =
    pool;

  return (
    <Link href={`/token/${token}`} className="row">
      <div className="row-n">{String(n).padStart(2, "0")}</div>

      <div className="row-id">
        <TokenArt token={token} symbol={symbol} uri={metadataURI} size={34} />
        <div style={{ minWidth: 0 }}>
          <div className="row-name">{name}</div>
          <div className="row-sub">
            {symbol}
            {" · "}
            <span className={`badge${armed ? " grad" : ""}`}>
              {armed ? "accruing" : "not armed"}
            </span>
          </div>
        </div>
      </div>

      <div className="num">
        <small>Realized LP</small>
        {fmtTokens(realizedLp)}
      </div>

      <div className="num">
        <small>Pending LP</small>
        {fmtTokens(pendingLp)}
      </div>

      <div className="num">
        <small>Claim ≈</small>
        {fmtEth(ethValue)} <span className="dim">ETH</span>
        {ethUsd ? (
          <div className="row-usd">{fmtUsd(usdFromWei(ethValue, ethUsd))}</div>
        ) : null}
      </div>
    </Link>
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
