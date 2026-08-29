"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import { fmtAge } from "@/lib/format";
import { CRITERIA_URL } from "@/lib/links";
import { fmtPoints } from "@/lib/points";
import { usePoints, useRedeem } from "@/lib/points-client";
import type { WaitlistState } from "@/lib/waitlist";

/**
 * What a registered wallet sees: the receipt, its uwPoints, and its referral link.
 *
 * This replaces the form outright rather than sitting under it. Registration is a
 * one-time, irreversible fact on chain — `standingOf` returns true and `register()`
 * reverts — so showing the four steps to a wallet that has already registered offers
 * work that cannot be done, ending at a disabled button. What a returning wallet gets
 * is a profile, not a form.
 *
 * The numbers are all derived, none stored: see UnderwaterPoints.sol on why, and
 * app/api/points/route.ts on how. What that means here is that the total and the
 * rows above it come from one fetch and so always agree, and that a wallet which
 * registered before the points contract existed still has its points — there is no
 * "points start here" line for it to be on the wrong side of.
 *
 * Every row renders at zero rather than being hidden, because the rows are also the
 * rate card. "Trades — 10 each" is worth more to a wallet that has never traded than
 * to one that has, and a card that only lists what you have already earned cannot
 * tell you what to do next.
 */
export function ReferralProfile({
  state,
  account,
  canRefer,
}: {
  state: WaitlistState;
  account: Address;
  /// Whether the registration window is still open. Gates the link and its note
  /// only: a referral link after close is a link that cannot pay, and offering it
  /// asks somebody to spend their reputation on nothing. The points above it stay,
  /// because launch and trade points keep accruing long after the waitlist shuts.
  canRefer: boolean;
}) {
  const { profile, isLoading } = usePoints(account);
  const [copied, setCopied] = useState(false);

  const referralLink = useMemo(() => {
    const { origin, pathname } = window.location;
    return `${origin}${pathname}?ref=${account}`;
  }, [account]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission). The link is
      // on screen either way, so this is a nicety, not a failure worth shouting.
    }
  }

  return (
    <div className="uw-profile">
      {/* The receipt. `.alert.ok` is the sheet's existing "this worked" panel, and
          this is the one unambiguous piece of good news on the card: you are in,
          and the chain says so rather than us. */}
      <div className="alert ok">
        <b>Application saved.</b> Number {String(state.position)} of{" "}
        {state.count.toLocaleString()}, {fmtAge(state.at)} ago — this address is in
        the pool the allowlist will be drawn from.
      </div>

      {/* The balance, which the card is built around. Rendered even before the
          fetch lands, as an em dash rather than a zero: a zero is a claim about
          this wallet, a dash is an admission about us. */}
      <div className="uw-balance">
        <span className="uw-balance-label">uwPoint balance</span>
        <b className="uw-balance-n">
          {profile ? fmtPoints(profile.points.total) : isLoading ? "…" : "—"}
        </b>
        {profile?.rank != null && (
          <span className="uw-balance-rank">
            Rank {profile.rank.toLocaleString()}
            {profile.rankOf ? <i>/{profile.rankOf.toLocaleString()}</i> : null}
          </span>
        )}
      </div>

      <dl className="uw-rows">
        <Row
          label="Registration"
          n={profile?.points.registration}
          note={profile && `${fmtPoints(profile.rates.register)} once`}
        />
        <Row
          label="Referrals"
          n={profile?.points.referral}
          note={
            profile &&
            `${profile.counts.validReferrals} valid of ${profile.counts.referrals} · ${fmtPoints(profile.rates.referral)} each`
          }
        />
        <Row
          label="Token launches"
          n={profile?.points.creation}
          note={
            profile &&
            `${profile.counts.creates} · ${fmtPoints(profile.rates.create)} each`
          }
        />
        <Row
          label="Trades"
          n={profile?.points.trading}
          note={
            profile &&
            `${profile.counts.trades} · ${fmtPoints(profile.rates.swap)} each`
          }
        />
        {/* Only when there is something in it. A "Coupons — 0" row on every card
            would advertise a mechanism most wallets have no code for. */}
        {profile && profile.points.granted > 0n && (
          <Row label="Coupons & grants" n={profile.points.granted} />
        )}
      </dl>

      {canRefer && (
        <>
          <div className="reflink">
            <code title={referralLink}>{referralLink}</code>
            <button onClick={copyLink}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="field-note">
            Every registration through your link is counted, and{" "}
            {profile ? fmtPoints(profile.rates.referral) : "1,000"} uwPoints are paid
            for each one that clears the activity bar — so a farm of fresh wallets
            earns nothing. The{" "}
            <a className="link" href={CRITERIA_URL} target="_blank" rel="noreferrer">
              selection criteria
            </a>{" "}
            say which referrals rank for the allowlist.
          </p>
        </>
      )}

      <Coupon />

      {/* The footnote, and it is not optional. These numbers are counted from
          public logs by a cache, which is a different thing from settled state, and
          a page that implies otherwise makes a promise the contract cannot keep. */}
      <p className="field-note uw-fine">
        uwPoints are counted from on-chain activity and will be redeemable for
        $WATER. Rates can change, and a change re-prices every balance.
        {profile?.ratesOnChain === false &&
          " No points contract is live on this network yet, so these rates are indicative."}
        {profile?.partial &&
          " Part of this chain's history could not be read just now, so the total may be low."}
      </p>
    </div>
  );
}

/**
 * One term of the balance: what it is, what it is worth, and how it was earned.
 *
 * The note sits on the value side and before the number, which is the house
 * pattern — see the allocation row in WaitlistPanel: value, then the dim qualifier
 * that makes it mean something. Before rather than after so the number still ends
 * at the row's right edge and the column of totals stays a column.
 */
function Row({
  label,
  n,
  note,
}: {
  label: string;
  n: bigint | undefined;
  /// `false`/`undefined` while the fetch is out — the rates are not known yet, and
  /// a guessed rate beside a real total is worse than no rate at all.
  note?: string | false;
}) {
  return (
    <div className="r-row uw-row">
      <dt>{label}</dt>
      <dd>
        {note && <span className="uw-row-note">{note}</span>}
        <span className={n !== undefined && n > 0n ? "gold" : "dim"}>
          {n === undefined ? "—" : fmtPoints(n)}
        </span>
      </dd>
    </div>
  );
}

/**
 * Coupon redemption, folded away until asked for.
 *
 * Collapsed because most wallets have no code, and an empty text field on a profile
 * card is a question the visitor cannot answer. A `<details>` rather than state: it
 * opens without JavaScript, is keyboard-reachable for free, and cannot get stuck
 * open across a wallet change.
 */
function Coupon() {
  const [code, setCode] = useState("");
  const { redeem, isPending, error, hash } = useRedeem();

  return (
    <details className="uw-coupon">
      <summary>Have a code?</summary>
      <div className="uw-coupon-form">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="UW-XXXX-XXXX-XXXX"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
        />
        <button
          type="button"
          disabled={!code.trim() || isPending}
          onClick={() => redeem(code.trim())}
        >
          {isPending ? "Sending…" : "Redeem"}
        </button>
      </div>
      {/* The contract's four refusals each mean something different to the person
          typing, so they are translated rather than forwarded. A raw revert in front
          of somebody who mistyped one character is not an error message. */}
      {error && <p className="field-note">{explainRedeem(error.message)}</p>}
      {hash && !error && (
        <p className="field-note">Redeemed — your balance updates within a minute.</p>
      )}
    </details>
  );
}

function explainRedeem(raw: string): string {
  if (/NoSuchCoupon/.test(raw)) return "No such code. Check it for a typo.";
  if (/CouponSpent/.test(raw)) return "This code has been fully used.";
  if (/NotYourCoupon/.test(raw)) return "This code was issued to another wallet.";
  if (/AlreadyRedeemed/.test(raw)) return "This wallet has already used this code.";
  if (/User rejected|denied/i.test(raw)) return "Cancelled in the wallet.";
  return raw.split("\n")[0];
}
