"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { WaitlistPanel } from "@/components/WaitlistPanel";
import { depthFromProgress, fmtDuration, fmtEth } from "@/lib/format";
import { PLATES, usePlatesState } from "@/lib/plates";
import { useWaitlist, useWaitlistState, useWaitlistWindow } from "@/lib/waitlist";

/**
 * The waterdrop — allowlist registration, on its own.
 *
 * A dedicated funnel rather than a panel bolted to the mint: registering is a
 * different act from buying, it opens and closes on its own window, and it
 * happens against a third, independent deploy (the waitlist), which a chain can
 * have without the collection. The page reads that deploy for the window and the
 * count, and the collection only for one settable number — `maxPerWallet`, which
 * is what turns the allocation into a number of people. Everything durable lives
 * on chain; the quest above the button is a prompt to act, and its one real
 * check — activity on Ink — is a signal, never a gate.
 */
export default function WaterdropPage() {
  const { address: account } = useAccount();

  const { address: waitlist } = useWaitlist();
  const {
    state: wlState,
    ready: wlReady,
    isLoading: wlLoading,
    refetch: refetchWaitlist,
  } = useWaitlistState(account);
  const wlWindow = useWaitlistWindow(wlState);

  // `maxPerWallet` is read off the collection because it is settable there, and
  // the panel needs it to say how many people the allocation reaches. The draw
  // tint follows the mint's progress, so the whole site darkens together.
  const { state: plates } = usePlatesState(account);
  const progressBps = Number((plates.minted * 10_000n) / PLATES.supply);
  const depth = depthFromProgress(progressBps);

  // What somebody deciding whether to bother actually wants to know: how many
  // people the allocation reaches, how much a spot saves, and whether the spots
  // have run out yet. `maxPerWallet` and both prices are settable on the
  // collection, so every one of these is derived from the chain read rather than
  // written down here — a page that hardcoded them would eventually disagree with
  // the contract it is describing.
  const perAddress = Math.max(1, Number(plates.maxPerWallet));
  const spots = Math.floor(Number(PLATES.wlAllocation) / perAddress);
  const registered = Number(wlState.count);
  // Rule 1 of the published criteria: at or under the spot count there is no
  // contest and everyone who registered is taken. Worth saying out loud while it
  // is still true, because it stops being true silently.
  const oversubscribed = spots > 0 && registered > spots;
  const discountPct =
    plates.price > plates.wlPrice && plates.price > 0n
      ? Math.round((1 - Number(plates.wlPrice) / Number(plates.price)) * 100)
      : 0;
  // Plates the allocation never claimed. The public phase is these plus whatever
  // the allowlist leaves behind.
  const publicPlates = PLATES.supply - PLATES.wlAllocation;

  // Which step of the procedure the chain is on. Only the window can say — the
  // steps after it are ours to run, and a page cannot claim they are done.
  const stage =
    wlWindow.kind === "before" ? 0 : wlWindow.kind === "open" ? 1 : 2;
  const stepState = (n: number) =>
    n < stage ? "done" : n === stage ? "now" : "next";

  const framing =
    wlWindow.kind === "open"
      ? {
          badge: wlState.registered ? "registered" : "open",
          title: wlState.registered
            ? "You are in the waterdrop."
            : "Join the waterdrop.",
          note: wlState.registered
            ? "This wallet is registered for the allowlist draw. There is nothing more to do — the list is readable on chain, the deadline cannot move, and nobody can remove you. Your number and referral link are in the panel."
            : "Register the wallet you want on the allowlist. It is a short quest and one transaction, and it reserves nothing: the allowlist is a Merkle tree drawn from everyone who registers, under criteria published before registration opened.",
        }
      : wlWindow.kind === "before"
        ? {
            badge: "soon",
            title: "The waterdrop opens soon.",
            note: `Registration opens in ${fmtDuration(
              wlWindow.opensIn,
            )}. There is no cap and no queue, so being first is worth nothing — come back when it opens.`,
          }
        : {
            badge: "closed",
            title: "The waterdrop has closed.",
            note: "Registration is closed and the list is fixed. The allowlist is drawn from it under the published criteria, and whatever the allowlist does not use rolls into the public phase — which is open to anyone.",
          };

  return (
    <div className="shell" style={{ ["--t" as string]: depth.toFixed(3) }}>
      <Masthead />

      {!waitlist ? (
        <NotDeployed>
          The waterdrop is not on this network. Switch networks in the masthead.
        </NotDeployed>
      ) : !wlReady && wlLoading ? (
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
                <span
                  className={
                    wlWindow.kind === "open" && !wlState.registered
                      ? "badge grad"
                      : "badge"
                  }
                >
                  {framing.badge}
                </span>
              </div>
              <h1 className="title" style={{ marginTop: 12 }}>
                {framing.title}
              </h1>
            </div>
            <p className="note">{framing.note}</p>

            <div className="hero-price">
              {wlState.count.toLocaleString()}
              <span>
                {wlState.count === 1n ? "wallet registered" : "wallets registered"}
              </span>
            </div>

            {/* The four numbers that decide whether registering is worth a
                transaction. The panel beside this states the same allocation as a
                fact; these state what it is worth — spots against arrivals, and
                the price the spot buys. */}
            <dl className="stats">
              <div className="stat">
                <dt>Spots</dt>
                <dd>{spots.toLocaleString()}</dd>
                <span className="stat-sub">
                  {String(plates.maxPerWallet)} per address
                </span>
              </div>
              <div className="stat">
                <dt>Demand</dt>
                <dd className={oversubscribed ? undefined : "ok"}>
                  {oversubscribed
                    ? `${(registered / spots).toFixed(1)}× the spots`
                    : "everyone fits"}
                </dd>
                <span className="stat-sub">
                  {registered.toLocaleString()} registered
                </span>
              </div>
              <div className="stat">
                <dt>{wlWindow.kind === "before" ? "Opens in" : "Closes in"}</dt>
                <dd
                  className={
                    wlWindow.kind === "open" || wlWindow.kind === "before"
                      ? undefined
                      : "warn"
                  }
                >
                  {wlWindow.kind === "before"
                    ? fmtDuration(wlWindow.opensIn)
                    : wlWindow.kind === "open"
                      ? fmtDuration(wlWindow.closesIn)
                      : "closed"}
                </dd>
                <span className="stat-sub">the window cannot move</span>
              </div>
              <div className="stat">
                <dt>Allowlist price</dt>
                <dd className={plates.wlPrice < plates.price ? "ok" : undefined}>
                  {plates.wlPrice === 0n
                    ? "free"
                    : `${fmtEth(plates.wlPrice, 6)} ETH`}
                </dd>
                <span className="stat-sub">
                  {discountPct > 0
                    ? `${discountPct}% under public`
                    : "same as public"}
                </span>
              </div>
            </dl>
          </div>

          {/* The procedure, in the reading column. This is why the page is not
              `.mint-stage.tight`: the panel beside it is a control and has to stay
              one, so everything a registrant has to understand before signing
              belongs here instead of pushed into 340px. See `.mint-stage` for the
              order these fall into on a phone — the control first, then this. */}
          <div className="stack mint-body">
            <div className="panel">
              <div className="panel-head">
                <span>How the draw works</span>
                <span className="dim">the procedure</span>
              </div>
              <ol className="drop-steps">
                <li className="drop-step" data-state={stepState(1)}>
                  <span className="drop-mark">1</span>
                  <span className="drop-body">
                    <b>Register</b>
                    <span>
                      One transaction, from the wallet you want on the list. Your
                      arrival number is written on chain as a receipt — it is not
                      an input to the result, so being early buys nothing.
                    </span>
                  </span>
                </li>
                <li className="drop-step" data-state={stepState(2)}>
                  <span className="drop-mark">2</span>
                  <span className="drop-body">
                    <b>The window closes</b>
                    <span>
                      The list is fixed, and the seed becomes the hash of the
                      first Ink block at or after the deadline. That block does
                      not exist while registration is open, so nobody — us
                      included — can play against it.
                    </span>
                  </span>
                </li>
                <li className="drop-step" data-state={stepState(3)}>
                  <span className="drop-mark">3</span>
                  <span className="drop-body">
                    <b>The top {spots.toLocaleString()} are taken</b>
                    <span>
                      Ranked by qualified referrals — wallets you brought in that
                      were already real on InkChain at the snapshot block — and the
                      seed breaks every tie, which for anyone who referred nobody
                      is the whole of it. A referral from a fresh wallet moves no
                      rank at all.
                    </span>
                  </span>
                </li>
                <li className="drop-step" data-state={stepState(4)}>
                  <span className="drop-mark">4</span>
                  <span className="drop-body">
                    <b>The root goes up</b>
                    <span>
                      One Merkle root, {String(plates.maxPerWallet)}{" "}
                      {plates.maxPerWallet === 1n ? "plate" : "plates"} per
                      address, set in a single transaction. From then on a spot in
                      the tree mints at the allowlist price.
                    </span>
                  </span>
                </li>
              </ol>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>If you are not selected</span>
                <span className="dim">the public phase</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                {String(publicPlates)} of the {String(PLATES.supply)} plates sit
                outside the allocation to begin with, and every allowlist plate
                the allowlist does not use rolls in beside them. The public phase
                mints at the public price and is open to anyone — no list, no
                proof, no form.
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                Opening it is one-way, and it does not close the allowlist. A spot
                in the tree is a right to the lower price for as long as the
                allocation lasts — not a place in a queue you can miss by being
                asleep.
              </p>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>Why you don&apos;t have to trust us</span>
                <span className="dim">the receipts</span>
              </div>
              {/* Deliberately a commitment and not a receipt. The criteria hash
                  is published on chain before the waitlist that binds it — but on
                  a deploy that predates the document (which the current testnet
                  one does) that ordering is not merely missing, it is impossible,
                  and no read this page can do would tell it apart from a chain
                  where the transaction is simply pending. So the copy says what is
                  promised and how to check, and hands the reader the one thing
                  that decides it: whether the transaction is there yet. */}
              <p className="note" style={{ fontSize: 12.5 }}>
                Not on our word. The selection criteria are a published document
                whose bytes are pinned, with the <b>keccak256</b> you should expect
                recorded beside them — so you compute the same 32 bytes we did
                rather than take ours. Before the waitlist that binds it is
                deployed, that hash goes on chain from the deployer, which
                timestamps it below the snapshot block and below every
                registration. The announcement carries the transaction alongside
                the waitlist address; until it is there, read the document as a
                commitment and not yet a receipt. A rule quietly changed
                afterwards would not line up.
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                When the list is drawn, three things are published with it: the
                intake read straight off this contract, the seed, and the tree.
                The same intake and the same seed produce the same root — so
                checking the result is not reading our summary of it, it is running
                the procedure and comparing 32 bytes against what is on chain.
              </p>
            </div>
          </div>

          <aside
            className={
              // The panel is a full quest — four steps and a button — only when
              // there is a wallet to run it against and it has not registered yet.
              // Every other state is a short receipt, and only those get to follow
              // the reading column: a sticky panel taller than the viewport pins
              // its top and puts its own Register button out of reach for good.
              wlWindow.kind === "open" && !!account && !wlState.registered
                ? "stack mint-side"
                : "stack mint-side drop-side"
            }
          >
            <WaitlistPanel
              waitlist={waitlist}
              state={wlState}
              window={wlWindow}
              allocation={PLATES.wlAllocation}
              perAddress={plates.maxPerWallet}
              onDone={refetchWaitlist}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
