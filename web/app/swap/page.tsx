"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { Modal } from "@/components/Modal";
import { CurveSwap, EthBadge, PoolSwap, SwapPlaceholder } from "@/components/SwapForm";
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

/**
 * Which leg the picker is filling.
 *
 * `subject` is the token the page is about: its curve progress, its graduation copy,
 * its token-page link. `counter` is what sits opposite it, and unlike the subject it
 * can be ETH — so only that leg's picker offers ETH, and only it is restricted to
 * graduated tokens, because a token still on its curve has no pool to route through.
 */
type Leg = "subject" | "counter";

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
  // Null is ETH, which is what every swap on this page was until now.
  const [counter, setCounter] = useState<Address | null>(null);
  const [picking, setPicking] = useState<Leg | null>(null);

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
  const known = !!detail.pool;
  const graduated = detail.pool?.graduated ?? false;

  // A curve has one counter-asset and it is ETH, so a token counter cannot survive
  // the subject moving to a token that has not graduated. Dropped here rather than
  // ignored downstream so that flipping back to a graduated subject doesn't restore a
  // counter the reader has long stopped seeing.
  useEffect(() => {
    if (counter && known && !graduated) setCounter(null);
  }, [counter, graduated, known]);

  /**
   * A leg's pick. Both write into the same two pieces of state, and the one rule
   * between them is that a token cannot be swapped for itself: landing on the other
   * leg's token clears that leg back to ETH rather than leaving a self-pair, which has
   * no pool behind it and nothing to quote.
   */
  const pick = (t: Address) => {
    if (picking === "counter") {
      setCounter(t.toLowerCase() === selected?.toLowerCase() ? null : t);
    } else {
      setSelected(t);
      if (t.toLowerCase() === counter?.toLowerCase()) setCounter(null);
    }
    setPicking(null);
  };
  const pickEth = () => {
    setCounter(null);
    setPicking(null);
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
            counter={counter}
            listings={listings}
            detail={detail}
            onChange={() => setPicking("subject")}
            onChangeCounter={() => setPicking("counter")}
          />
        ) : (
          // No token yet — still the swap box, because that is what the page is.
          // Reached while the list is loading, and on a network where nothing has
          // launched at all; in both cases pressing anything opens the picker,
          // which takes a pasted address as well as a listed launch.
          <>
            <SwapPlaceholder
              loading={loadingList}
              onSelectToken={() => setPicking("subject")}
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
          open={picking !== null}
          onClose={() => setPicking(null)}
          title={picking === "counter" ? "Swap against" : "Select a token"}
        >
          <TokenPicker
            leg={picking ?? "subject"}
            listings={listings}
            holdings={holdings}
            exclude={
              (picking === "counter" ? selected : counter) ?? undefined
            }
            onPick={pick}
            onPickEth={pickEth}
          />
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

/**
 * The picker, for either leg.
 *
 * The counter leg differs in two ways and both are consequences of what liquidity
 * exists rather than of taste. It offers ETH, because ETH is a real choice there and
 * the only way back to a single-hop swap once a token has been picked. And it offers
 * only *graduated* tokens: the route is TOKEN → WETH → TOKEN, so the second hop needs
 * a pool, and a token still on its curve has none — listing it would be offering a
 * swap the router cannot price.
 */
function TokenPicker({
  leg,
  listings,
  holdings,
  exclude,
  onPick,
  onPickEth,
}: {
  leg: Leg;
  listings: Listing[];
  holdings: Holding[];
  /** The other leg's token. Nothing can be swapped for itself. */
  exclude?: Address;
  onPick: (t: Address) => void;
  onPickEth: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const counter = leg === "counter";

  const eligible = useMemo(() => {
    const skip = exclude?.toLowerCase();
    const ok = (t: { token: Address; pool: { graduated: boolean } }) =>
      t.token.toLowerCase() !== skip && (!counter || t.pool.graduated);
    return {
      listings: listings.filter(ok),
      holdings: holdings.filter(ok),
    };
  }, [counter, exclude, holdings, listings]);

  const results = useMemo(() => {
    if (!q) return eligible.listings.slice(0, MAX_RESULTS);
    return eligible.listings
      .filter((l) =>
        `${l.name} ${l.symbol} ${l.token}`.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [eligible.listings, q]);

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

      {counter && !q && (
        <div className="swap-list">
          <button type="button" className="swap-opt" onClick={onPickEth}>
            <EthBadge size={30} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row-name">ETH</div>
              <div className="row-sub">One hop · every pool is paired to it</div>
            </div>
            <span className="num dim">→</span>
          </button>
        </div>
      )}

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

      {eligible.holdings.length > 0 && !q && (
        <>
          <div className="sec">
            <span>Your positions</span>
          </div>
          <div className="swap-list">
            {eligible.holdings.slice(0, MAX_QUICK).map((h) => (
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
        <span>
          {q ? "Matches" : counter ? "Graduated launches" : "Recent launches"}
        </span>
      </div>
      {results.length === 0 ? (
        <div className="empty">
          {counter && !q
            ? "Nothing has graduated on this network yet — ETH is the only counter-asset."
            : "Nothing matches that"}
        </div>
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
  counter,
  listings,
  detail,
  onChange,
  onChangeCounter,
}: {
  token: Address;
  counter: Address | null;
  listings: Listing[];
  detail: ReturnType<typeof useTokenDetail>;
  onChange: () => void;
  onChangeCounter: () => void;
}) {
  const {
    pool,
    pair,
    imported,
    symbol,
    metadataURI,
    balance,
    allowance,
    priceE18,
    progress,
    isLoading,
    refetch,
  } = detail;

  // The counter's art and ticker, from the list the picker chose it out of. No second
  // `useTokenDetail`: only graduated launches are offered as a counter and those are
  // all inside the market window, so the listing is already here — and a whole extra
  // detail read for one chip's label would be paid on every render of the page.
  const other = useMemo(() => {
    if (!counter) return undefined;
    const found = listings.find(
      (l) => l.token.toLowerCase() === counter.toLowerCase(),
    );
    return {
      token: counter,
      symbol: found?.symbol || shortAddr(counter),
      uri: found?.metadataURI ?? "",
    };
  }, [counter, listings]);

  if (isLoading && !pool) return <div className="empty">Sounding…</div>;

  /**
   * Whether this trades through the router rather than the launchpad.
   *
   * Two ways to be true, and the second one is why this is a variable instead of
   * `pool.graduated` inline: a graduation, or a pool somebody opened for a token the
   * launchpad never minted (see `isImported`). `PoolSwap` needs neither a curve nor a
   * launch — `usePoolTrade` resolves the pair off the factory and quotes it with the
   * router — so an imported token was always tradable here and only the branch below
   * was turning it away.
   */
  const viaPool = pool?.graduated || (imported && !!pair);

  if (!viaPool && !pool?.exists) {
    return (
      <div className="empty">
        No launch at this address, and no pool on our DEX
        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 10,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <button type="button" onClick={onChange}>
            Pick another token
          </button>
          {/* Offered rather than hidden: if this really is a token on this chain,
              the reason it cannot be swapped is that nothing has put liquidity
              behind it, and that is something the reader can do. */}
          <Link href={`/import?token=${token}`} className="btn">
            Open a pool for it →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="swap-console">
      {pool && !pool.graduated && (
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

      {viaPool ? (
        <PoolSwap
          token={token}
          symbol={symbol || "tokens"}
          uri={metadataURI}
          counter={other}
          onSelectToken={onChange}
          onSelectCounter={onChangeCounter}
        />
      ) : (
        <CurveSwap
          token={token}
          symbol={symbol || "tokens"}
          uri={metadataURI}
          balance={balance}
          allowance={allowance}
          priceE18={priceE18}
          onDone={refetch}
          onSelectToken={onChange}
        />
      )}

      <p className="note" style={{ fontSize: 12.5, textAlign: "center" }}>
        {!pool ? (
          <>
            An imported pool — no launch behind it, no curve, and the liquidity is{" "}
            <b>not</b> burned: whoever opened it holds the LP tokens and can
            withdraw them. Swaps pay <b>0.30%</b> to liquidity, same as any pool
            here.
          </>
        ) : pool.graduated ? (
          <>
            This token has graduated — swaps run through the burned-liquidity
            pool on our DEX and pay <b>0.30%</b> to liquidity. Any other graduated
            token can be the other leg; the route crosses both pools and pays the
            fee twice.
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
