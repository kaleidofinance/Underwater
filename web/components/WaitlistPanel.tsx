"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { waitlistAbi } from "@/lib/abis";
import { fmtAge, fmtDuration } from "@/lib/format";
import type { InkActivity, WaitlistState, WaitlistWindow } from "@/lib/waitlist";

const X_HANDLE = "underwaterxyz";
const X_URL = `https://x.com/${X_HANDLE}`;

/**
 * The meme question is a lightweight are-you-awake check, not a quiz. Anything
 * that shows you read the word passes — the list is generous on purpose, because
 * a gate that rejects a right-in-spirit answer is pure friction and this gate
 * guards nothing a contract relies on.
 */
const MEME_ANSWERS = [
  "water",
  "liquid",
  "nothing",
  "salt",
  "h2o",
  "sea",
  "ocean",
  "fish",
  "brine",
  "me",
  "everything",
  "you",
  "us",
  "debt",
];

function memeAccepted(raw: string): boolean {
  const a = raw.trim().toLowerCase();
  if (a.length < 2) return false;
  return MEME_ANSWERS.some((k) => a === k || a.includes(k));
}

/**
 * Allowlist registration, as a short quest.
 *
 * The steps are a funnel, and the panel is honest about which of them are real.
 * The two social steps are on the registrant's honour — this app has no server
 * and no X credentials, so a checkbox is the truthful ceiling and the copy says
 * as much rather than implying a verification that is not happening. The meme
 * answer is checked in the browser. The Ink-activity line is a genuine on-chain
 * read (the wallet's nonce), shown as a signal and not a gate: the contract
 * accepts any address, and the published criteria rank by referrals — a fresh
 * wallet can still register, it just brings no rank of its own until it refers.
 *
 * What registering buys is intake, not entitlement — the allowlist is a Merkle
 * tree drawn from this list afterward, under criteria published beforehand
 * (ALLOWLIST.md). Overpromising here is the one thing this component could do
 * that a contract cannot undo, so arrival number is shown as a receipt, and the
 * referral tally is shown for what the criteria make it — the rank — with the one
 * caveat a raw on-chain count cannot: only referrals of wallets that were real on
 * Ink count toward it.
 */
export function WaitlistPanel({
  waitlist,
  state,
  window: win,
  ink,
  allocation,
  perAddress,
  onDone,
}: {
  waitlist: Address;
  state: WaitlistState;
  window: WaitlistWindow;
  /// Whether the connected wallet has ever transacted on this chain.
  ink: InkActivity;
  /// Plates held for the allowlist. A contract `constant`.
  allocation: bigint;
  /// `maxPerWallet` as it stands on the collection right now — settable, so it is
  /// read from the chain and passed in rather than written here. It is what turns
  /// the allocation into a number of people, which is the whole question somebody
  /// registering is asking.
  perAddress: bigint;
  onDone: () => void;
}) {
  const { address: account, isConnected } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Quest state. Local and deliberately un-persisted: these are a prompt to act,
  // not a record, and the only durable fact — that you registered — lives on
  // chain where nobody can lie about it.
  const [followed, setFollowed] = useState(false);
  const [retweeted, setRetweeted] = useState(false);
  const [answer, setAnswer] = useState("");
  const [copied, setCopied] = useState(false);

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
  const memeOk = memeAccepted(answer);
  const questDone = followed && retweeted && memeOk;
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

  const referralLink = useMemo(() => {
    if (!account) return "";
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?ref=${account}`;
  }, [account]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission). The link
      // is on screen either way, so this is a nicety, not a failure worth shouting.
    }
  }

  const people = Math.floor(Number(allocation) / Math.max(1, Number(perAddress)));

  return (
    <div className="panel">
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
            {String(allocation)}{" "}
            <span className="dim">{String(perAddress)} per address</span>
          </dd>
        </div>
        <div className="r-row">
          <dt>{win.kind === "closed" ? "Registration" : "Closes in"}</dt>
          <dd className={win.kind === "closed" ? "dim" : undefined}>
            {win.kind === "closed" ? "closed" : fmtDuration(win.closesIn)}
          </dd>
        </div>
      </dl>

      {/* Registered: the receipt, plus the referral board. */}
      {state.registered ? (
        <>
          <div className="alert ok" style={{ marginBottom: 14 }}>
            You are registered — number {String(state.position)} of{" "}
            {state.count.toLocaleString()}, {fmtAge(state.at)} ago. This address is
            in the pool the allowlist will be drawn from.
          </div>

          <dl style={{ marginBottom: 12 }}>
            <div className="r-row">
              <dt>Your referrals</dt>
              <dd className={state.referrals > 0n ? "gold" : "dim"}>
                {String(state.referrals)}
              </dd>
            </div>
          </dl>

          {win.kind === "open" && referralLink && (
            <>
              <div className="reflink">
                <code title={referralLink}>{referralLink}</code>
                <button onClick={copyLink}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <p className="field-note" style={{ marginTop: 8, marginBottom: 0 }}>
                Share this to climb the referral board. If more people register than
                there are spots, this board is the rank — but only referrals of
                wallets already real on Ink count toward it, so a farm of fresh
                wallets is worth nothing. The number above is every referral; the{" "}
                <a className="link" href="/ALLOWLIST.md" target="_blank" rel="noreferrer">
                  selection criteria
                </a>{" "}
                say which of them rank.
              </p>
            </>
          )}
        </>
      ) : win.kind === "closed" ? (
        <div className="alert" style={{ marginBottom: 14 }}>
          Registration has closed and this address is not on the list. The public
          phase is open to anyone, and whatever the allowlist does not use rolls
          into it.
        </div>
      ) : win.kind === "before" ? (
        <div className="alert" style={{ marginBottom: 14 }}>
          Registration opens in {fmtDuration(win.opensIn)}. Nothing to do until
          then — there is no cap and no queue, so being first is worth nothing.
        </div>
      ) : !isConnected ? (
        <div className="alert" style={{ marginBottom: 14 }}>
          Connect a wallet to register. Registration is a transaction from the
          address you want on the list — there is no form, and no email.
        </div>
      ) : (
        // Open, connected, not yet registered: the quest.
        <>
          {usableReferrer && (
            <p className="field-note" style={{ marginTop: 0, marginBottom: 12 }}>
              Referred by {usableReferrer.slice(0, 6)}…{usableReferrer.slice(-4)} —
              they get the credit. If this wallet was already active on Ink, that
              credit counts toward their rank; your own registration is unaffected
              either way.
            </p>
          )}

          <div className="quest">
            <a
              className="quest-step"
              data-done={followed ? "true" : "false"}
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => setFollowed(true)}
            >
              <span className="quest-box">{followed ? "✓" : ""}</span>
              <span className="quest-body">
                <b>Follow @{X_HANDLE}</b>
                <span>Opens X. Tapping marks this done — on your honour.</span>
              </span>
            </a>

            <a
              className="quest-step"
              data-done={retweeted ? "true" : "false"}
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => setRetweeted(true)}
            >
              <span className="quest-box">{retweeted ? "✓" : ""}</span>
              <span className="quest-body">
                <b>Repost the pinned post</b>
                <span>Also on your honour — nothing here checks X.</span>
              </span>
            </a>

            <label
              className="quest-step static"
              data-done={memeOk ? "true" : answer ? "pending" : "false"}
            >
              <span className="quest-box">{memeOk ? "✓" : ""}</span>
              <span className="quest-body">
                <b>What is underwater?</b>
                <span>One word. There are no wrong answers, only empty ones.</span>
                <input
                  type="text"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </span>
            </label>

            <div
              className="quest-step static"
              data-done={ink.transacted ? "true" : "false"}
            >
              <span className="quest-box">{ink.transacted ? "✓" : ""}</span>
              <span className="quest-body">
                <b>Active on Ink</b>
                <span>
                  {ink.transacted === undefined
                    ? "Checking this wallet's Ink history…"
                    : ink.transacted
                      ? `This wallet has transacted on Ink (${ink.nonce} sent). A real signal — and if someone referred you, it is what makes their referral count.`
                      : "No Ink history on this wallet. You can still register — but a referral of a brand-new wallet counts toward no one's rank."}
                </span>
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

      {/* The honest part. A waitlist that implies a guaranteed spot and then
          publishes a tree without you is worse than no waitlist. */}
      <p className="field-note" style={{ marginTop: 14 }}>
        Registering does not reserve a plate. The allowlist is a Merkle tree built
        from this list under criteria published before registration opened, and{" "}
        {String(allocation)} plates at {String(perAddress)} per address means it
        reaches around {people} people. Arrival order is a receipt, not a rank —
        the rank is referrals, how many real wallets you brought in.
      </p>
      <p className="field-note" style={{ marginBottom: 0 }}>
        The contract has no owner and no setter: once you are in it, nobody can
        remove you, and the deadline cannot move. The whole list is readable on
        chain, so the tree we publish can be rebuilt by anyone.
      </p>
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
      "Registration has not opened yet. The window is immutable, so this is the time that was published.",
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
