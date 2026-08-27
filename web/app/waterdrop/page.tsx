"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { WaitlistPanel } from "@/components/WaitlistPanel";
import { depthFromProgress, fmtDuration } from "@/lib/format";
import { PLATES, usePlatesState } from "@/lib/plates";
import {
  useInkActivity,
  useWaitlist,
  useWaitlistState,
  useWaitlistWindow,
} from "@/lib/waitlist";

/**
 * The waterdrop — allowlist registration, on its own.
 *
 * A dedicated funnel rather than a panel bolted to the mint: registering is a
 * different act from buying, it opens and closes on its own window, and it
 * happens against a third, independent deploy (the waitlist), which a chain can
 * have without the collection. The page reads that deploy for the window and the
 * count, and the collection only for one settable number — `maxPerWallet`, which
 * is what turns the allocation into a number of people. Everything durable lives
 * on chain; the quest above the button is a prompt to act, and the panel is
 * honest about which of its steps are actually verified.
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
  // The wallet's Ink history, for the quest's one honest on-chain step. A signal
  // in the panel, never a gate — see `useInkActivity`.
  const ink = useInkActivity(account);

  // `maxPerWallet` is read off the collection because it is settable there, and
  // the panel needs it to say how many people the allocation reaches. The draw
  // tint follows the mint's progress, so the whole site darkens together.
  const { state: plates } = usePlatesState(account);
  const progressBps = Number((plates.minted * 10_000n) / PLATES.supply);
  const depth = depthFromProgress(progressBps);

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
          </div>

          <div className="stack mint-body">
            <div className="panel">
              <div className="panel-head">
                <span>How the draw works</span>
                <span className="dim">the honest part</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                Registering is intake, not entitlement. When more register than
                there are spots, the allowlist ranks them by referrals — how many
                wallets you brought in that were already real on Ink — and fills the
                rest by lottery. The procedure is fixed and hashed on chain before
                registration opened, every step a function of public data and
                reproducible by anyone who disagrees with the result.
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                So arrival order is a receipt, not a rank — the rank is your
                qualified referrals, and a referral from a fresh wallet counts for
                nothing, which is why a farm cannot buy its way up. The tally in the
                panel is every referral; which of them count is written down in{" "}
                <a
                  className="link"
                  href="/ALLOWLIST.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  the selection criteria
                </a>
                .
              </p>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>What registering can and cannot do</span>
                <span className="dim">trust</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                The waitlist contract has no owner and no setter. Once this wallet
                is in it, nobody can remove it and the deadline cannot move; the
                whole list is readable on chain, so the tree we publish can be
                rebuilt by anyone. Registering one address costs only gas, which
                means it cannot promise a spot — one person can register many
                wallets, and the criteria, not the contract, decide who is picked.
              </p>
              <p className="note" style={{ fontSize: 12.5, marginBottom: 0 }}>
                The two social steps are on your honour: this site has no server
                and no X credentials, so a tick is the truthful ceiling and the
                panel says so rather than implying a check it cannot make. The
                Ink-activity line is a real on-chain read, shown as a signal and
                never a gate — a fresh wallet can still register.
              </p>
            </div>
          </div>

          <aside className="stack mint-side">
            <WaitlistPanel
              waitlist={waitlist}
              state={wlState}
              window={wlWindow}
              ink={ink}
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
