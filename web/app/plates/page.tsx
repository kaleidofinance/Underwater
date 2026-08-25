"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAccount, useChainId } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { PlateArt } from "@/components/PlateArt";
import { chainById } from "@/lib/chains";
import { depthFromProgress, fmtDuration, fmtEth, shortAddr } from "@/lib/format";
import {
  PHASE_COPY,
  PLATES,
  usePhase,
  usePlates,
  usePlatesState,
  useMembership,
} from "@/lib/plates";
import {
  useWaitlist,
  useWaitlistState,
  useWaitlistWindow,
} from "@/lib/waitlist";

/// A 1e18-scaled health factor, the way Aave writes one: "1.00", "1.40". Not
/// `fmtEth` — these are ratios that happen to share its scaling, and trimming
/// 1.00 to "1" makes a threshold look like a rounding.
function hf(scaled: bigint): string {
  return (Number(scaled) / 1e18).toFixed(2);
}

/**
 * The collection's home — what a plate is.
 *
 * This is the showcase: the story, the on-chain art, the provenance and the
 * collection's shape, plus whatever the connected wallet already holds. The two
 * things you can *do* — mint, and register for the allowlist draw — live on their
 * own routes (`/mint`, `/waterdrop`), and this page sends you to them rather than
 * embedding either, so the page a visitor lands on is about the collection and
 * not a checkout. Every number is read from the collection on an 8-second poll,
 * never written here — see `usePlatesState`; only the contract's `constant`s are
 * hard-coded, in `PLATES`.
 */
export default function PlatesPage() {
  const { address: plates } = usePlates();
  const chainId = useChainId();
  const { address: account, isConnected } = useAccount();

  const { state, ready, isLoading } = usePlatesState(account);
  const phase = usePhase(state);
  const membership = useMembership(account, state.merkleRoot);

  // The waitlist, only so the "join the waterdrop" call to action can name the
  // window's state and whether this wallet is already in it. No registration
  // happens here — that is the whole of `/waterdrop`.
  const { address: waitlist } = useWaitlist();
  const { state: wlState } = useWaitlistState(account);
  const wlWindow = useWaitlistWindow(wlState);

  // The page gets shallower and brighter as the collection fills, the same way a
  // token page does as its curve fills.
  const progressBps = Number((state.minted * 10_000n) / PLATES.supply);
  const depth = depthFromProgress(progressBps);
  const explorer = chainById(chainId)?.blockExplorers?.default.url;
  const copy = PHASE_COPY[phase.kind];
  const hasRenderer = !/^0x0+$/.test(state.renderer);

  // Which call to action is the primary one. A live mint is the headline; before
  // there is anything to sell, the waterdrop is — so exactly one gold button is
  // shown at a time and it is the thing this visitor can actually act on.
  const live = phase.kind === "allowlist" || phase.kind === "public";
  const waterdropShown = waitlist !== null && wlWindow.kind !== "unconfigured";
  const waterdropPrimary =
    !live && wlWindow.kind === "open" && !wlState.registered;

  // The treasury's reserve is minted at seal, so the lowest ids exist before
  // anybody buys anything — which makes them the only plates guaranteed to be
  // there to show. Three once the traits are readable: enough to see that the
  // art varies, few enough that the page is not doing a dozen `tokenURI` calls
  // to prove it. One before the reveal, because `traitsOf` reverts until the
  // offset is drawn and every plate renders the same blank — three copies of an
  // identical placeholder would read as "the art does not vary".
  const want = state.isRevealed ? 3n : 1n;
  const shown = Number(state.minted >= want ? want : state.minted);
  const sample = useMemo(
    () => Array.from({ length: shown }, (_, i) => BigInt(i + 1)),
    [shown],
  );

  return (
    <div className="shell" style={{ ["--t" as string]: depth.toFixed(3) }}>
      <Masthead />

      {!plates ? (
        <NotDeployed>
          The collection is not on this network. Switch networks in the masthead.
        </NotDeployed>
      ) : !ready && isLoading ? (
        <div className="empty">Sounding…</div>
      ) : (
        <div className="stage mint-stage">
          <div className="stack mint-hero">
            <div>
              <span className={phase.kind === "public" ? "badge grad" : "badge"}>
                {copy.badge}
              </span>
              <h1 className="title" style={{ marginTop: 12 }}>
                {copy.title}
              </h1>
            </div>
            <p className="note">{copy.note}</p>

            <div className="hero-price">
              {String(state.minted)}
              <span>of {String(PLATES.supply)} minted</span>
            </div>

            <div>
              <div className="depth">
                <i style={{ width: `${Math.min(100, progressBps / 100)}%` }} />
              </div>
              <div className="depth-cap">
                <span>
                  {phase.remaining === 0n
                    ? "none left"
                    : `${String(phase.remaining)} still available`}
                </span>
                <span className={progressBps >= 10_000 ? "gold" : ""}>
                  {(progressBps / 100).toFixed(1)}%
                </span>
              </div>
            </div>

            <dl className="stats">
              <div className="stat">
                <dt>Public price</dt>
                <dd>{state.price === 0n ? "free" : `${fmtEth(state.price, 6)} ETH`}</dd>
                <span className="stat-sub">per plate · settable</span>
              </div>
              <div className="stat">
                <dt>Allowlist price</dt>
                <dd className={state.wlPrice < state.price ? "ok" : undefined}>
                  {state.wlPrice === 0n ? "free" : `${fmtEth(state.wlPrice, 6)} ETH`}
                </dd>
                <span className="stat-sub">
                  {state.price > state.wlPrice && state.price > 0n
                    ? `${Math.round(
                        (1 - Number(state.wlPrice) / Number(state.price)) * 100,
                      )}% under public`
                    : "same as public"}
                </span>
              </div>
              <div className="stat">
                <dt>Allowlist left</dt>
                <dd>
                  {String(phase.wlRemaining)}{" "}
                  <span className="dim">/ {String(PLATES.wlAllocation)}</span>
                </dd>
                <span className="stat-sub">
                  {phase.wlRemaining === 0n
                    ? "allocation finished"
                    : `${String(state.wlMinted)} taken`}
                </span>
              </div>
              <div className="stat">
                <dt>Mint closes</dt>
                <dd className={phase.closesIn === 0 ? "warn" : undefined}>
                  {phase.closesIn === 0 ? "closed" : fmtDuration(phase.closesIn)}
                </dd>
                <span className="stat-sub">
                  {phase.closesIn === 0
                    ? "the reveal can be drawn"
                    : "then the reveal can be drawn"}
                </span>
              </div>
            </dl>
          </div>

          {/* Everything that explains the thing, under the numbers on a wide
              screen and under the calls to action on a narrow one — see
              `.mint-stage`. */}
          <div className="stack mint-body">
            <div className="panel">
              <div className="panel-head">
                <span>What a plate is</span>
                <span className="dim">the mechanic</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                A plate is an ink drawing of a leveraged position. Attach one to a
                borrow account with <b>dive</b> and the art starts reading that
                account&apos;s health factor from Aave, on every render: crisp at
                the surface, dissolving into plumes as the position sinks.
              </p>
              <p className="note" style={{ fontSize: 12.5 }}>
                Below a health factor of <b>{hf(PLATES.scarHf)}</b> anyone may
                engrave a <b>scar</b> — permanent, up to{" "}
                {String(PLATES.maxScars)}, kept through every sale. At{" "}
                <b>{hf(PLATES.drownHf)}</b> or below anyone may <b>drown</b> it:
                the plate is burned and a trophy is minted to whoever called it.
                That is not a metaphor for liquidation, it is the same condition
                Aave liquidates on.
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                Nothing forces you to dive. A plate in dry dock reads as{" "}
                <b>afloat</b> and cannot be scarred or drowned — it is also the
                only plate that can never earn either.
              </p>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>Drawn on read</span>
                <span className="dim">
                  {hasRenderer ? "on chain" : "no renderer yet"}
                </span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                There is no image host and no IPFS pin. <b>tokenURI</b> composes
                the metadata and the SVG in the call itself, reading the position
                behind the plate at that moment — so the art below is being drawn
                by the contract as this page loads it, not fetched from anywhere.
              </p>
              {sample.length > 0 && hasRenderer ? (
                <>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 12,
                      justifyContent: "center",
                    }}
                  >
                    {sample.map((id) => (
                      <PlateArt
                        key={String(id)}
                        plates={plates}
                        id={id}
                        size={120}
                      />
                    ))}
                  </div>
                  {!state.isRevealed && (
                    <p
                      className="field-note"
                      style={{ marginBottom: 0, textAlign: "center" }}
                    >
                      Blank on purpose: before the reveal every plate draws the
                      same empty card, because the traits genuinely are not
                      assigned yet.
                    </p>
                  )}
                </>
              ) : (
                <p className="field-note" style={{ marginBottom: 0 }}>
                  {!hasRenderer
                    ? "The renderer is not set on this deployment yet, so there is nothing for the contract to draw with."
                    : "Nothing has been minted here yet, so there is no plate to draw."}
                </p>
              )}
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>The table was fixed before the mint</span>
                <span className="dim">provenance</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                All {String(PLATES.supply)} trait sets are written on chain as{" "}
                {String(PLATES.categories)} four-bit fields per plate, and{" "}
                <b>seal</b> refuses to open the mint unless they hash to the
                provenance below — published before a single plate existed. The
                rarity distribution therefore could not have been edited in
                response to how the mint was going.
              </p>
              <dl>
                <div className="r-row">
                  <dt>Provenance</dt>
                  <dd className="ellipsis" title={state.provenance}>
                    {shortAddr(state.provenance)}
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Table sealed</dt>
                  <dd className={state.isSealed ? "gold" : "dim"}>
                    {state.isSealed ? "yes" : "not yet"}
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Revealed</dt>
                  <dd className={state.isRevealed ? "gold" : "dim"}>
                    {state.isRevealed
                      ? "yes"
                      : phase.remaining === 0n || phase.closesIn === 0
                        ? "ready to draw"
                        : "after the mint"}
                  </dd>
                </div>
              </dl>
              <p className="field-note" style={{ marginBottom: 0 }}>
                Which slot a plate number maps to is a single offset, drawn once
                the mint is finished or the window has closed. Minting early buys a
                number, not a plate.
              </p>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>The collection</span>
              </div>
              <dl>
                <div className="r-row">
                  <dt>Supply</dt>
                  <dd>{String(PLATES.supply)}</dd>
                </div>
                <div className="r-row">
                  <dt>Held for the allowlist</dt>
                  <dd>
                    {String(PLATES.wlAllocation)}{" "}
                    <span className="dim">rolls into public if unused</span>
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Treasury reserve</dt>
                  <dd>
                    {String(state.reserve)}{" "}
                    <span className="dim">minted at seal</span>
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Per transaction</dt>
                  <dd>{String(state.maxPerTx)}</dd>
                </div>
                <div className="r-row">
                  <dt>Per address, allowlist</dt>
                  <dd>{String(state.maxPerWallet)}</dd>
                </div>
                <div className="r-row">
                  <dt>Secondary royalty</dt>
                  <dd>{Number(PLATES.royaltyBps) / 100}%</dd>
                </div>
                <div className="r-row">
                  <dt>Collection</dt>
                  <dd>
                    {plates && explorer ? (
                      <a
                        className="link"
                        href={`${explorer}/address/${plates}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddr(plates)} ↗
                      </a>
                    ) : (
                      plates && shortAddr(plates)
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <aside className="stack mint-side">
            <div className="panel">
              <div className="panel-head">
                <span>Get a plate</span>
                <span className="dim">{waterdropShown ? "two ways" : "mint"}</span>
              </div>

              <Link
                href="/mint"
                className={`btn${live ? " primary" : ""}`}
                style={{ display: "block", textAlign: "center", width: "100%" }}
              >
                {live
                  ? "Mint a plate"
                  : phase.kind === "soldout"
                    ? "Sold out — see the mint"
                    : phase.kind === "over"
                      ? "Mint closed — see the mint"
                      : "See the mint"}
              </Link>
              <p className="field-note" style={{ marginTop: 10, marginBottom: 0 }}>
                {live
                  ? "Mint at the allowlist price if you are on it, the public price otherwise. Your eligibility and the exact price are on the mint."
                  : phase.kind === "unsealed"
                    ? "Nothing is for sale until the trait table is sealed. The mint page shows the live state."
                    : phase.kind === "waiting"
                      ? "Sealed and waiting for a phase to open. The mint page shows the live state."
                      : "The mint page shows the final state and any plates you hold."}
              </p>

              {waterdropShown && (
                <>
                  <Link
                    href="/waterdrop"
                    className={`btn${waterdropPrimary ? " primary" : ""}`}
                    style={{
                      display: "block",
                      textAlign: "center",
                      width: "100%",
                      marginTop: 14,
                    }}
                  >
                    {wlState.registered
                      ? "You are in the waterdrop ✓"
                      : wlWindow.kind === "open"
                        ? "Join the waterdrop"
                        : wlWindow.kind === "before"
                          ? `Waterdrop opens in ${fmtDuration(wlWindow.opensIn)}`
                          : "Waterdrop closed"}
                  </Link>
                  <p
                    className="field-note"
                    style={{ marginTop: 10, marginBottom: 0 }}
                  >
                    {wlState.registered
                      ? "You are registered for the allowlist draw. Open the waterdrop for your number and referral link."
                      : wlWindow.kind === "open"
                        ? "Register for the allowlist draw — a short quest, one transaction. It reserves nothing: the allowlist is drawn from registrants under criteria published beforehand."
                        : wlWindow.kind === "before"
                          ? "Allowlist registration has not opened yet. There is no queue, so being early is worth nothing."
                          : "Allowlist registration has closed. Whatever the allowlist does not use rolls into the public phase."}
                  </p>
                </>
              )}
            </div>

            {isConnected && (
              <div className="panel">
                <div className="panel-head">
                  <span>Your plates</span>
                </div>
                <dl>
                  <div className="r-row">
                    <dt>Held</dt>
                    <dd className={state.owned > 0n ? "gold" : ""}>
                      {String(state.owned)}
                    </dd>
                  </div>
                  <div className="r-row">
                    <dt>Taken from the allowlist</dt>
                    <dd>
                      {String(state.claimed)}{" "}
                      <span className="dim">of {String(state.maxPerWallet)}</span>
                    </dd>
                  </div>
                  <div className="r-row">
                    <dt>On the allowlist</dt>
                    <dd
                      className={
                        membership.proof && membership.rootMatches ? "gold" : "dim"
                      }
                    >
                      {membership.isLoading
                        ? "checking…"
                        : !membership.published
                          ? "no list published"
                          : !membership.rootMatches
                            ? "list does not match chain"
                            : membership.proof
                              ? "yes"
                              : "no"}
                    </dd>
                  </div>
                </dl>
                {/* No token list: the ERC721 here is not enumerable, on purpose —
                    an owner-index costs every mint gas to build. A wallet or the
                    explorer will list them. */}
                <p className="field-note" style={{ marginBottom: 0 }}>
                  {membership.published
                    ? `${membership.members.toLocaleString()} addresses on the published list.`
                    : "The allowlist is published as a static file of proofs once it is drawn up."}
                </p>
              </div>
            )}

            <div className="panel">
              <div className="panel-head">
                <span>What can still change</span>
                <span className="dim">trust</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                Both prices, both limits and the allowlist root are settable by
                the owner — the price targets a dollar figure and a fixed amount
                of ETH cannot hold one. Every price is bounded by{" "}
                <b>{fmtEth(PLATES.priceCeiling)} ETH</b> and every limit by{" "}
                <b>{String(PLATES.limitCeiling)}</b>, in the contract, and payment
                must be exact — so a re-peg mid-transaction reverts instead of
                overcharging.
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                What cannot change: the supply, the sealed trait table, the
                provenance hash, the Aave pool the art reads, the treasury
                reserve, and the deadline. The renderer can be replaced until it
                is frozen{" "}
                <span className="dim">
                  ({hasRenderer ? "one is set" : "none set yet"})
                </span>
                .
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
