"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { CurveSwap, PoolSwap, SwapPlaceholder } from "@/components/SwapForm";
import { TokenArt } from "@/components/TokenArt";
import { CURVE } from "@/lib/contracts";
import {
  depthFromProgress,
  fmtEth,
  fmtPriceGwei,
  fmtTokens,
  shortAddr,
} from "@/lib/format";
import { useLaunchpad, useListings, useTokenDetail, type Listing } from "@/lib/hooks";
import { useProfile, type Holding } from "@/lib/profile";
import { fmtUsdPrice, useEthUsd, usdFromWei } from "@/lib/usd";

/** How many candidates the picker shows before you have to narrow the search. */
const MAX_RESULTS = 30;
/** Your own positions, offered as one-tap picks — the common case is selling. */
const MAX_QUICK = 6;

// `useSearchParams` forces a Suspense boundary, so the page is the boundary and
// the console does the work — a deep link like /swap?token=0x… lands on it ready.
export default function SwapPage() {
  return (
    <Suspense fallback={<SwapShell depth={0} />}>
      <SwapInner />
    </Suspense>
  );
}

/** The shell + masthead, shared by the Suspense fallback and every real state. */
function SwapShell({
  depth,
  children,
}: {
  depth: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="shell" style={{ ["--t" as string]: depth.toFixed(3) }}>
      <Masthead />
      {children}
    </div>
  );
}

function SwapInner() {
  const { configured } = useLaunchpad();
  const params = useSearchParams();
  const fromLink = params.get("token");
  const initial = fromLink && isAddress(fromLink) ? getAddress(fromLink) : null;

  const [selected, setSelected] = useState<Address | null>(initial);
  const [picking, setPicking] = useState(false);

  const { address: account } = useAccount();
  // 100 to match useProfile's window, so React Query serves both from one read.
  const { listings, isLoading: loadingList } = useListings(100);
  const { holdings } = useProfile();

  // The page opens on a working swap box, not on a chooser: with no ?token the
  // newest launch is the subject, and the token is changed from the From/To chip
  // like any other DEX. Seeded once — latching it means a launch landing mid-
  // session (the list refetches on a timer) can't swap the token out from under
  // someone who is halfway through typing an amount.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || selected || listings.length === 0) return;
    seeded.current = true;
    setSelected(listings[0].token);
  }, [listings, selected]);

  const detail = useTokenDetail(selected ?? undefined, account);

  const pick = (t: Address) => {
    setSelected(t);
    setPicking(false);
  };

  // The page sits at the depth of the token being swapped, exactly like the
  // market and the token page — an about-to-graduate token surfaces the console.
  const depth = useMemo(
    () => depthFromProgress(selected ? detail.progress : 0),
    [selected, detail.progress],
  );

  if (!configured) {
    return (
      <SwapShell depth={0}>
        <NotDeployed>
          Swapping opens once the launchpad is live on this network. Switch
          networks in the masthead.
        </NotDeployed>
      </SwapShell>
    );
  }

  return (
    <SwapShell depth={depth}>
      <div className="swap-wrap">
        <div className="sec">
          <h1>Swap</h1>
          <Link href="/profile" className="prof-addr">
            Your profile →
          </Link>
        </div>

        {selected ? (
          <SwapConsole
            token={selected}
            detail={detail}
            onChange={() => setPicking(true)}
          />
        ) : (
          // No token yet — still the swap box, because that is what the page is.
          // Reached while the list is loading, and on a network where nothing has
          // launched at all; in both cases pressing anything opens the picker,
          // which takes a pasted address as well as a listed launch.
          <>
            <SwapPlaceholder
              loading={loadingList}
              onSelectToken={() => setPicking(true)}
            />
            {!loadingList && listings.length === 0 && (
              <p className="note" style={{ textAlign: "center" }}>
                Nothing has launched on this network yet.{" "}
                <Link href="/launch" className="link">
                  Launch the first one →
                </Link>
              </p>
            )}
          </>
        )}

        <Modal
          open={picking}
          onClose={() => setPicking(false)}
          title="Select a token"
        >
          <TokenPicker listings={listings} holdings={holdings} onPick={pick} />
        </Modal>
      </div>
    </SwapShell>
  );
}

/** A token as a one-tap pick — art, identity, spot price. Shared by both lists. */
function PickRow({
  listing,
  onPick,
  tag,
}: {
  listing: Listing;
  onPick: (t: Address) => void;
  tag?: string;
}) {
  const ethUsd = useEthUsd();
  return (
    <button
      type="button"
      className="swap-opt"
      onClick={() => onPick(listing.token)}
    >
      <TokenArt
        token={listing.token}
        symbol={listing.symbol}
        uri={listing.metadataURI}
        size={30}
      />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row-name">{listing.name}</div>
        <div className="row-sub">
          {listing.symbol}
          {listing.pool.graduated && (
            <>
              {" · "}
              <span className="gold">pool</span>
            </>
          )}
          {tag && ` · ${tag}`}
        </div>
      </div>
      <div className="num" style={{ whiteSpace: "nowrap" }}>
        {ethUsd ? (
          fmtUsdPrice(usdFromWei(listing.priceE18, ethUsd))
        ) : (
          <>
            {fmtPriceGwei(listing.priceE18)} <span className="dim">gwei</span>
          </>
        )}
      </div>
    </button>
  );
}

function TokenPicker({
  listings,
  holdings,
  onPick,
}: {
  listings: Listing[];
  holdings: Holding[];
  onPick: (t: Address) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return listings.slice(0, MAX_RESULTS);
    return listings
      .filter((l) =>
        `${l.name} ${l.symbol} ${l.token}`.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [listings, q]);

  // A pasted address that is a real launch but sits outside the scan window is
  // still swappable — useTokenDetail reads it straight from the launchpad.
  const asAddr = isAddress(query.trim()) ? getAddress(query.trim()) : null;
  const known =
    asAddr && results.some((r) => r.token.toLowerCase() === asAddr.toLowerCase());

  return (
    <div className="swap-pick">
      <div className="field" style={{ marginTop: 0 }}>
        <label htmlFor="swap-q">Pick a token</label>
        <input
          id="swap-q"
          type="text"
          value={query}
          placeholder="Name, ticker or address"
          aria-label="Find a token to swap by name, ticker or address"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {asAddr && !known && (
        <button
          type="button"
          className="swap-opt"
          onClick={() => onPick(asAddr)}
        >
          <TokenArt token={asAddr} symbol="?" uri="" size={30} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row-name">{shortAddr(asAddr)}</div>
            <div className="row-sub">Swap this address</div>
          </div>
          <span className="num dim">→</span>
        </button>
      )}

      {holdings.length > 0 && !q && (
        <>
          <div className="sec">
            <span>Your positions</span>
          </div>
          <div className="swap-list">
            {holdings.slice(0, MAX_QUICK).map((h) => (
              <PickRow
                key={h.token}
                listing={h}
                onPick={onPick}
                tag={`${fmtTokens(h.balance)} held`}
              />
            ))}
          </div>
        </>
      )}

      <div className="sec">
        <span>{q ? "Matches" : "Recent launches"}</span>
      </div>
      {results.length === 0 ? (
        <div className="empty">Nothing matches that</div>
      ) : (
        <div className="swap-list">
          {results.map((l) => (
            <PickRow key={l.token} listing={l} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The swap box and nothing else in front of it.
 *
 * This used to open with a header — art, name, ticker, a Change button — and a
 * hero price under it. All four were already on screen: the token chip in the
 * From/To leg carries the art and the ticker and opens the same picker when
 * pressed, so the header was a second copy of the control directly below it, and
 * a page whose one job is a swap box was showing the box third. The price and the
 * rest of the detail are a click away on the token page, linked at the foot.
 */
function SwapConsole({
  token,
  detail,
  onChange,
}: {
  token: Address;
  detail: ReturnType<typeof useTokenDetail>;
  onChange: () => void;
}) {
  const {
    pool,
    symbol,
    metadataURI,
    balance,
    allowance,
    progress,
    isLoading,
    refetch,
  } = detail;

  if (isLoading && !pool) return <div className="empty">Sounding…</div>;

  if (!pool || !pool.exists) {
    return (
      <div className="empty">
        No launch at this address
        <div style={{ marginTop: 18 }}>
          <button type="button" onClick={onChange}>
            Pick another token
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="swap-console">
      {!pool.graduated && (
        <div>
          <div className="depth">
            <i style={{ width: `${Math.min(100, progress / 100)}%` }} />
          </div>
          <div className="depth-cap">
            <span>
              {fmtEth(pool.realEthRaised)} / {fmtEth(CURVE.graduationEth)} ETH
            </span>
            <span className={progress >= 10_000 ? "gold" : ""}>
              {(progress / 100).toFixed(1)}%
            </span>
          </div>
        </div>
      )}

      {pool.graduated ? (
        <PoolSwap
          token={token}
          symbol={symbol || "tokens"}
          uri={metadataURI}
          onSelectToken={onChange}
        />
      ) : (
        <CurveSwap
          token={token}
          symbol={symbol || "tokens"}
          uri={metadataURI}
          balance={balance}
          allowance={allowance}
          onDone={refetch}
          onSelectToken={onChange}
        />
      )}

      <p className="note" style={{ fontSize: 12.5, textAlign: "center" }}>
        {pool.graduated ? (
          <>
            This token has graduated — swaps run through the burned-liquidity
            pool on our DEX and pay <b>0.30%</b> to liquidity.
          </>
        ) : (
          <>
            Still on its bonding curve — trades price off a virtual reserve and
            pay the launchpad&apos;s curve fee. It graduates to a pool at{" "}
            <b>{fmtEth(CURVE.graduationEth)} ETH</b> raised.
          </>
        )}{" "}
        <Link href={`/token/${token}`} className="link">
          Open the full token page →
        </Link>
      </p>
    </div>
  );
}
