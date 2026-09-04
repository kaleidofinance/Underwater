"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ReferralProfile } from "@/components/ReferralProfile";
import { waitlistAbi } from "@/lib/abis";
import { fmtDuration } from "@/lib/format";
import { MIN_INK_TXNS, useEligibilityCheck } from "@/lib/waitlist";
import type { Eligibility, WaitlistState, WaitlistWindow } from "@/lib/waitlist";

const X_HANDLE = "underwaterxyz";
const X_URL = `https://x.com/${X_HANDLE}`;

/**
 * The check question. One right answer, and it is Arjun Sethi — Kraken's co-CEO,
 * and Ink is Kraken's chain, so anybody who has read a word about where this
 * launches knows it and anybody who has not can find it in one search. That is the
 * bar: awake and paying attention, not initiated.
 *
 * Matched on either name, after everything that is not a letter comes out of the
 * input. So `Arjun Sethi`, `arjunsethi`, `@arjunsethi`, `arjun-sethi`, `ARJUN`,
 * `Sethi` and `mr. arjun sethi` all pass, and so does a sentence with the name in
 * it. Deliberately that loose: this question gates nothing a contract relies on —
 * the button it unlocks calls `register()`, which takes any address — so a wrong
 * rejection is pure friction with nothing bought by it, and the failure worth
 * avoiding is the one where somebody who knows the answer cannot get in because
 * they typed it with a space.
 */
const CEO_NAMES = ["arjun", "sethi"];

function answerAccepted(raw: string): boolean {
  const a = raw.toLowerCase().replace(/[^a-z]/g, "");
  return CEO_NAMES.some((name) => a.includes(name));
}

/**
 * Allowlist registration, as a short quest.
 *
 * The steps are a funnel. The two social steps ask for a handle and a repost
 * link: the site has no X credentials and does not call the X API, so these are
 * an attestation the browser keeps rather than a verification — asking for them
 * outright, instead of a verify button that would imply an X-API check that is
 * not wired, is the honest form, so the interface itself stays plain. The CEO
 * question is checked in the browser, and generously — see `answerAccepted`. The
 * activity step is a real, run-on-demand check with two ways to pass — a
 * transaction count on Ink Mainnet or Ink Sepolia, or a DeFi position on Ink
 * Mainnet — a signal and not a gate: the contract accepts any address and the
 * published criteria rank by referrals, so a fresh wallet can still register, it
 * just brings no rank of its own until it refers.
 *
 * What registering buys is intake, not entitlement — the allowlist is a Merkle
 * tree drawn from this list afterward, under criteria published beforehand
 * (ALLOWLIST.md). Overpromising here is the one thing this component could do
 * that a contract cannot undo, so the receipt and the standing are stated
 * carefully — see components/ReferralProfile.tsx, which owns everything a wallet
 * sees once it has registered.
 *
 * That split is the shape of the panel: **registered or not is a fork, not a
 * disclosure.** Registration is one-time and irreversible on chain, so a wallet
 * that has done it is shown its profile *instead of* the form, not underneath one.
 * The steps used to render again on reconnect, ending at a disabled button — an
 * interface asking for work it would refuse to accept.
 */
export function WaitlistPanel({
  waitlist,
  state,
  window: win,
  stats,
  onDone,
}: {
  waitlist: Address;
  state: WaitlistState;
  window: WaitlistWindow;
  /// The head and the three rows above the form: this panel's own title and
  /// countdown, how many have registered, and the allocation. Omit it and the
  /// panel is the form alone.
  ///
  /// One prop carrying both the switch and the numbers, rather than a flag beside
  /// them, so asking for the rows and having something to put in them cannot come
  /// apart. `allocation` is the plates held for the allowlist, a contract
  /// `constant`. `perAddress` is `maxPerWallet` as it stands right now — settable,
  /// so it is read from the chain rather than written here, and it sits beside the
  /// allocation because how many a wallet may take is what makes the allocation
  /// mean anything. The caller is expected to have floored it at 1: on a network
  /// with intake but no collection that read comes back zero, and the substitution
  /// is the page's to make because the page is what knows why.
  ///
  /// /waterdrop passes it, because there the head is the sidebar's only label and
  /// the page's own `dl.stats` says what the numbers are *worth* rather than
  /// restating them. Optional because the pre-launch gate rendered this panel too
  /// and omitted it: that card carried its own title, and the countdown appeared
  /// twice in four rows. The gate is retired, so nothing omits it today — the prop
  /// stays optional because whether the surrounding page has already said these
  /// numbers is the page's business and not the panel's.
  stats?: { allocation: bigint; perAddress: bigint };
  onDone: () => void;
}) {
  const { address: account, isConnected } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Quest state. Local and deliberately un-persisted: these are a prompt to act,
  // not a record, and the only durable fact — that you registered — lives on
  // chain where nobody can lie about it. The handle and repost link are an
  // attestation the site cannot verify (no server, no X credentials), so they
  // gate the button and go no further than this browser.
  const [handle, setHandle] = useState("");
  const [repostLink, setRepostLink] = useState("");
  const [answer, setAnswer] = useState("");

  // The eligibility check, fired by a button below. A signal, never a gate.
  const verify = useEligibilityCheck(account);

  // The referrer, from `?ref=0x…`. Read from the URL in an effect rather than via
  // useSearchParams so the panel needs no Suspense boundary, and validated hard:
  // a mangled link should register the person holding it, not revert on them.
  const [referrer, setReferrer] = useState<Address | null>(null);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("ref");
    setReferrer(raw && isAddress(raw) ? (raw as Address) : null);
  }, []);

  // A self-referral is refused by the contract, so drop it here rather than let
  // the register button revert. Compared lower-case because a link may carry a
  // checksummed address against a lower-cased connected one.
  const usableReferrer =
    referrer && account && referrer.toLowerCase() !== account.toLowerCase()
      ? referrer
      : null;

  useEffect(() => {
    if (isSuccess) onDone();
  }, [isSuccess, onDone]);

  const busy = isPending || mining;
  const answerOk = answerAccepted(answer);
  // The handle is an attestation, not a lookup, so it is validated for shape
  // only: X handles are 1–15 of [A-Za-z0-9_], with an optional leading @.
  const cleanHandle = handle.trim().replace(/^@+/, "");
  const handleOk = /^[A-Za-z0-9_]{1,15}$/.test(cleanHandle);
  const repostOk = /^https?:\/\/\S{4,}/i.test(repostLink.trim());
  const questDone = handleOk && repostOk && answerOk;
  const canRegister =
    isConnected && win.kind === "open" && !state.registered && !busy && questDone;

  function register() {
    reset();
    if (usableReferrer) {
      writeContract({
        address: waitlist,
        abi: waitlistAbi,
        functionName: "registerWith",
        args: [usableReferrer],
      });
    } else {
      writeContract({ address: waitlist, abi: waitlistAbi, functionName: "register" });
    }
  }

  return (
    <div className="panel">
      {stats && (
        <>
          <div className="panel-head">
            <span>Allowlist waitlist</span>
            <span className="dim">
              {win.kind === "open"
                ? `closes in ${fmtDuration(win.closesIn)}`
                : win.kind === "before"
                  ? `opens in ${fmtDuration(win.opensIn)}`
                  : "closed"}
            </span>
          </div>

          <dl style={{ marginBottom: 16 }}>
            <div className="r-row">
              <dt>Registered</dt>
              <dd className={state.count > 0n ? "gold" : "dim"}>
                {state.count.toLocaleString()}{" "}
                <span className="dim">
                  {state.count === 1n ? "address" : "addresses"}
                </span>
              </dd>
            </div>
            <div className="r-row">
              <dt>Allowlist plates</dt>
              <dd>
                {String(stats.allocation)}{" "}
                <span className="dim">{String(stats.perAddress)} per address</span>
              </dd>
            </div>
            <div className="r-row">
              <dt>{win.kind === "closed" ? "Registration" : "Closes in"}</dt>
              <dd className={win.kind === "closed" ? "dim" : undefined}>
                {win.kind === "closed" ? "closed" : fmtDuration(win.closesIn)}
              </dd>
            </div>
          </dl>
        </>
      )}
      {/* Registered: the profile, not the form. A wallet that has registered
          cannot register again — `register()` reverts on it — so the four steps
          would be work with no button at the end. components/ReferralProfile.tsx
          takes over from here: receipt, uwPoints, rank, referral link. */}
      {state.registered ? (
        account ? (
          <ReferralProfile
            state={state}
            account={account}
            canRefer={win.kind === "open"}
          />
        ) : null
      ) : win.kind === "closed" ? (
        <div className="alert info" style={{ marginBottom: 14 }}>
          Registration has closed and this address is not on the list. The public
          phase is open to anyone, and whatever the allowlist does not use rolls
          into it.
        </div>
      ) : win.kind === "before" ? (
        <div className="alert info" style={{ marginBottom: 14 }}>
          Registration opens in {fmtDuration(win.opensIn)}. Nothing to do until
          then — there is no cap and no queue, so being first is worth nothing.
        </div>
      ) : (
        // Open and not yet registered: the quest. Reached whether or not a wallet
        // is connected — there used to be a "connect a wallet to register" notice
        // in front of this, and the button below already says "Connect a wallet"
        // and stays disabled until one is. So a visitor arriving without a wallet
        // reads what registering will ask of them instead of being told to come
        // back with one first, and the steps are the argument for connecting.
        <>
          {usableReferrer && (
            <p className="field-note" style={{ marginTop: 0, marginBottom: 12 }}>
              Referred by {usableReferrer.slice(0, 6)}…{usableReferrer.slice(-4)} —
              they get the credit. If this wallet was already active on InkChain, that
              credit counts toward their rank; your own registration is unaffected
              either way.
            </p>
          )}

          <div className="quest">
            <label
              className="quest-step static"
              data-done={handleOk ? "true" : handle ? "pending" : "false"}
            >
              <span className="quest-box">{handleOk ? "✓" : ""}</span>
              <span className="quest-body">
                <span className="quest-top">
                  <b>Follow @{X_HANDLE}</b>
                  {/* The step's action, at the end of the step's own head rather
                      than inside a sentence below it. See `.quest-top`: the
                      sentence was saying what the title and the field already say
                      between them, and it was hiding the link. */}
                  <a
                    className="quest-act"
                    href={X_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open X ↗
                  </a>
                </span>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="@yourhandle"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                />
              </span>
            </label>

            <label
              className="quest-step static"
              data-done={repostOk ? "true" : repostLink ? "pending" : "false"}
            >
              <span className="quest-box">{repostOk ? "✓" : ""}</span>
              <span className="quest-body">
                <span className="quest-top">
                  <b>Repost the pinned post</b>
                  <a
                    className="quest-act"
                    href={X_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open X ↗
                  </a>
                </span>
                <input
                  type="text"
                  value={repostLink}
                  onChange={(e) => setRepostLink(e.target.value)}
                  placeholder="https://x.com/you/status/…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </span>
            </label>

            <label
              className="quest-step static"
              data-done={answerOk ? "true" : answer ? "pending" : "false"}
            >
              <span className="quest-box">{answerOk ? "✓" : ""}</span>
              <span className="quest-body">
                <span className="quest-top">
                  <b>Who is InkChain&apos;s CEO?</b>
                </span>
                {/* The one step that keeps a line of prose. This question has a
                    right answer, so the line says how forgiving the matching is —
                    see `answerAccepted`. Without it, somebody who knows the answer
                    still has to guess whether the form wants a full name. */}
                <span className="quest-note">
                  Either name will do, and spacing and capitals do not matter.
                </span>
                {/* No example in the placeholder here, unlike the two steps above:
                    the only example there is to give is the answer. */}
                <input
                  type="text"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="a name"
                  spellCheck={false}
                  autoComplete="off"
                />
              </span>
            </label>

            <div
              className="quest-step static"
              data-done={verify.status === "passed" ? "true" : "false"}
            >
              <span className="quest-box">
                {verify.status === "passed" ? "✓" : ""}
              </span>
              <span className="quest-body">
                <span className="quest-top">
                  {/* Both networks named, because the check passes on activity on
                      either one — `useEligibilityCheck` reads the nonce on Ink
                      Mainnet and on Ink Sepolia and takes the higher. This used to
                      say "Active on InkChain" to avoid picking one of them, which
                      dodged the problem rather than answering it: the brand name is
                      not a network, and a wallet that had only ever touched the
                      testnet had no way to tell whether it counted.

                      The threshold is interpolated, not typed. It is the same
                      constant the check compares against and the same one the
                      failure line quotes, so raising the bar cannot leave this head
                      advertising the old number. */}
                  <b>
                    Must have min {MIN_INK_TXNS} txns on Ink mainnet or testnet
                  </b>
                  <button
                    type="button"
                    className="quest-btn"
                    onClick={verify.run}
                    disabled={!account || verify.status === "checking"}
                  >
                    {/* "Try again" belongs to the one case where the check itself
                        did not complete. A wallet that simply did not clear the bar
                        got a real answer, and telling it to try again reads as an
                        error and contradicts the line below it — nothing to retry,
                        but worth re-running once the wallet has done more on Ink. */}
                    {verify.status === "checking"
                      ? "Checking…"
                      : verify.status === "idle"
                        ? "Verify"
                        : verify.status === "error"
                          ? "Try again"
                          : "Re-check"}
                  </button>
                </span>
                {/* The other line of prose, and here it is the result. */}
                <span className="quest-note">{eligibilityNote(verify)}</span>
              </span>
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="alert" style={{ marginBottom: 14 }}>
          {explain((error as Error).message)}
        </div>
      )}

      {!state.registered && (
        <button
          className="primary"
          disabled={!canRegister}
          onClick={register}
          style={{ width: "100%" }}
        >
          {isPending
            ? "Confirm in wallet…"
            : mining
              ? "Registering…"
              : win.kind === "open"
                ? !isConnected
                  ? "Connect a wallet"
                  : questDone
                    ? "Register"
                    : "Finish the steps to register"
                : win.kind === "before"
                  ? "Not open yet"
                  : "Registration closed"}
        </button>
      )}
    </div>
  );
}

/**
 * A wallet error in the waitlist's own words.
 *
 * Each reachable revert means the page's state was stale rather than that the
 * caller did anything wrong — so each says what to do instead of naming the revert.
 */
function explain(message: string): string {
  const known: [string, string][] = [
    [
      "AlreadyRegistered",
      "This address is already on the waitlist. Nothing more to do — one registration per address is all it takes.",
    ],
    [
      "NotOpen",
      "Registration has not opened yet. This is the time the contract currently publishes — read it from the contract rather than from here.",
    ],
    [
      "Closed",
      "Registration closed while this was being prepared. Nothing was charged.",
    ],
    [
      "BadReferrer",
      "That referral link is not usable from this address — it may be your own, or the referrer never registered. Registering without it works.",
    ],
  ];
  for (const [error, prose] of known) {
    if (message.includes(error)) return prose;
  }
  return message.split("\n")[0];
}

/**
 * The Active-on-Ink line, per check state.
 *
 * Kept out of the JSX because the passed case names which of the two signals
 * cleared it, and a ternary that long in the markup is unreadable.
 *
 * Every branch that could be read as a rejection says outright that registering
 * still works — the check is a signal, and the copy must not let it read as a
 * gate. Written to one line at the panel's width where the state allows it: this is
 * the step whose line changes, and it is the one thing on the panel that can push
 * the register button off a short screen.
 */
function eligibilityNote(v: Eligibility): string {
  switch (v.status) {
    case "checking":
      return "Checking this wallet on Ink…";
    case "passed": {
      const via =
        v.via === "defi"
          ? "it holds a DeFi position on Ink Mainnet"
          : (v.mainnetTxns ?? 0) >= MIN_INK_TXNS
            ? `${v.mainnetTxns} transactions on Ink Mainnet`
            : `${v.sepoliaTxns} transactions on Ink Sepolia`;
      return `Verified — ${via}.`;
    }
    case "failed":
      return `Under ${MIN_INK_TXNS} transactions, no DeFi position. Register anyway — a fresh wallet just ranks for nobody.`;
    case "error":
      return "Could not reach Ink. This never blocks registering — try again.";
    default:
      return "A signal, never a gate — a fresh wallet can still register.";
  }
}
