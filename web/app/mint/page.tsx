"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { MintPanel } from "@/components/MintPanel";
import { depthFromProgress, fmtDuration, fmtEth } from "@/lib/format";
import {
  PHASE_COPY,
  PLATES,
  usePhase,
  usePlates,
  usePlatesState,
  useMembership,
} from "@/lib/plates";

/**
 * The checkout.
 *
 * The mint, and only the mint. The collection's story, its art and its
 * provenance live on `/plates`, and allowlist registration lives on
 * `/waterdrop`; this page carries just enough of the collection's live state to
 * make the buy explainable — the phase, the two prices, how much of each
 * allocation is left — and hands the rest to `MintPanel`, which is the one place
 * a plate is actually bought. Every number is read from the contract on the same
 * 8-second poll as the showcase, because `_takePayment` demands *exact* payment
 * and a page holding a stale price sends a transaction that reverts with
 * `WrongPayment` and no explanation.
 */
export default function MintPage() {
  const { address: plates } = usePlates();
  const { address: account, isConnected } = useAccount();

  const { state, ready, isLoading, refetch } = usePlatesState(account);
  const phase = usePhase(state);
  const membership = useMembership(account, state.merkleRoot);

  // The checkout gets shallower and brighter as the collection fills, the same
  // way the showcase and a token page do.
  const progressBps = Number((state.minted * 10_000n) / PLATES.supply);
  const depth = depthFromProgress(progressBps);
  const copy = PHASE_COPY[phase.kind];

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
              <Link
                href="/plates"
                className="link"
                style={{ fontSize: 11, letterSpacing: "0.04em" }}
              >
                ← The collection
              </Link>
              <div style={{ marginTop: 12 }}>
                <span className={phase.kind === "public" ? "badge grad" : "badge"}>
                  {copy.badge}
                </span>
              </div>
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

          {/* A checkout, not an explainer: one paragraph of what this is, and a
              door back to the page that tells the whole story. */}
          <div className="stack mint-body">
            <div className="panel">
              <div className="panel-head">
                <span>What you&apos;re minting</span>
                <span className="dim">the collection</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                A plate is an ink drawing of a leveraged position that reads its
                account&apos;s Aave health factor on every render — crisp at the
                surface, dissolving as it sinks. The full story, the on-chain art
                and the provenance hash are on{" "}
                <Link className="link" href="/plates">
                  the collection page
                </Link>
                .
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                All {String(PLATES.supply)} trait sets were sealed against a
                provenance hash before any plate existed, and every price and
                limit here is read from the contract live — payment is exact, so a
                stale quote reverts instead of overcharging. Registering for the
                allowlist draw happens in the{" "}
                <Link className="link" href="/waterdrop">
                  waterdrop
                </Link>
                .
              </p>
            </div>
          </div>

          <aside className="stack mint-side">
            <MintPanel
              plates={plates}
              state={state}
              phase={phase}
              membership={membership}
              onDone={refetch}
            />

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
                <p className="field-note" style={{ marginBottom: 0 }}>
                  {membership.published
                    ? `${membership.members.toLocaleString()} addresses on the published list.`
                    : "The allowlist is published as a static file of proofs once it is drawn up."}
                </p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
