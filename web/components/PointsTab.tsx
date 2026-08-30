"use client";

import Link from "next/link";
import type { Address } from "viem";
import { chainById } from "@/lib/chains";
import { shortAddr } from "@/lib/format";
import { useHydratedChainId } from "@/lib/hydration";
import { fmtPoints, type PointEvent } from "@/lib/points";
import { usePoints, usePointsHistory } from "@/lib/points-client";

/**
 * The wallet's uwPoints, and every event that produced them.
 *
 * Its own tab rather than a block inside Rewards, because the two answer different
 * questions. Rewards is a pitch — what $WATER will be, who it goes to, nothing to claim
 * yet — and a pitch is read once. This is a statement: a balance, the terms that sum to
 * it, and the list of on-chain events each term was counted from. That gets read every
 * time the number changes, and it is the only thing on the site that can settle an
 * argument about a balance.
 *
 * Which is the whole reason the history is here and not just the total. Points are not
 * stored anywhere — see lib/points.ts — so a balance is a claim we compute, and a claim
 * nobody can check is a claim nobody has to believe. Every row links to the transaction
 * it was read from, so the arithmetic can be audited by somebody who does not trust us:
 * the rows and the total come from the same events, priced by the same rate card, in one
 * pair of fetches that cannot disagree about the rates.
 */
export function PointsTab() {
  const { profile, isLoading } = usePoints();
  const pts = (n: bigint | undefined) =>
    n === undefined ? (isLoading ? "…" : "—") : fmtPoints(n);

  return (
    <div className="prof-points">
      <div className="uw-balance">
        <span className="uw-balance-label">uwPoint balance</span>
        <b className="uw-balance-n">{pts(profile?.points.total)}</b>
        {profile?.rank != null && (
          <span className="uw-balance-rank">
            Rank {profile.rank.toLocaleString()}
            {profile.rankOf ? <i>/{profile.rankOf.toLocaleString()}</i> : null}
          </span>
        )}
      </div>

      {/* Every term renders at zero rather than being hidden, because the rows are also
          the rate card: "Trades — 10 each" is worth more to a wallet that has never
          traded than to one that has. Same decision, same reasoning, as the waterdrop
          card — and literally the same rows, so one balance looks like one balance
          wherever it is read. */}
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
          label="Launches"
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
        {/* Only when there is something in it. A "Coupons — 0" row on every profile
            would advertise a mechanism most wallets have no code for. */}
        {profile && profile.points.granted > 0n && (
          <Row label="Coupons & grants" n={profile.points.granted} />
        )}
      </dl>

      <History />

      <p className="field-note">
        Points are recomputed from on-chain logs on every read, so a rate change
        re-prices what is already here — including the rows above, which are priced at
        today&apos;s card and not at whatever the rate was on the day.
        {profile?.ratesOnChain === false &&
          " No points contract is live on this network yet, so these rates are indicative."}
      </p>
    </div>
  );
}

/**
 * One term of the balance. Lifted verbatim from the waterdrop card, note placement and
 * all — see components/ReferralProfile.tsx for why the qualifier sits before the number.
 */
function Row({
  label,
  n,
  note,
}: {
  label: string;
  n: bigint | undefined;
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
 * The list, newest first.
 *
 * Paged by asking the route for a longer list rather than by appending — `usePointsHistory`
 * explains why that is cheaper here than a cursor. What it means on screen is that "Load
 * more" extends the list in place instead of blanking it, so `isFetching` is worth showing
 * on the button and nowhere else.
 *
 * `allTime` is the one status worth stating out loud. Every other list on the site is a
 * window over recent blocks; this one claims to be a wallet's whole record, and that claim
 * is only true once the walk has reached the first of our deployments. Until then the list
 * says so rather than letting a short list imply a quiet wallet.
 */
function History() {
  const { events, more, allTime, partial, isLoading, isFetching, error, loadMore, atMax } =
    usePointsHistory();

  return (
    <>
      <div className="sec">
        <span>History</span>
        <span className="dim">
          {events.length === 0
            ? ""
            : allTime
              ? `all ${events.length.toLocaleString()}`
              : `newest ${events.length.toLocaleString()}`}
        </span>
      </div>

      {error ? (
        <p className="field-note">
          This RPC would not serve the log range, so the list is unavailable. The balance
          above is counted by the same scan and may also be short.
        </p>
      ) : isLoading && events.length === 0 ? (
        <div className="empty">Sounding…</div>
      ) : events.length === 0 ? (
        <div className="empty">
          Nothing on this wallet&apos;s record yet
          <div
            className="note"
            style={{ marginTop: 14, textTransform: "none", letterSpacing: 0 }}
          >
            Points are earned by registering for the waterdrop, launching a token,
            trading, and referring wallets that go on to use the protocol.
          </div>
        </div>
      ) : (
        <>
          <div className="pts-hist">
            {events.map((e) => (
              <EventRow key={`${e.txHash}:${e.logIndex}`} event={e} />
            ))}
          </div>

          {/* Shown only when there is somewhere further back to go. At the route's
              ceiling the button stands down and says where the list stops, rather than
              pretending one more press would reach further. */}
          {more && (
            <div className="pts-more">
              {atMax ? (
                <span className="dim">
                  The deepest {events.length.toLocaleString()} events. Older ones are on
                  chain and still count toward the balance.
                </span>
              ) : (
                <button type="button" disabled={isFetching} onClick={loadMore}>
                  {isFetching ? "Reading…" : "Load more"}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {(partial || (!allTime && events.length > 0)) && (
        <p className="field-note">
          {!allTime &&
            "This wallet's history is still being walked backwards, so the earliest events may not be listed yet. "}
          {partial &&
            "Some dates and referral verdicts are still being fetched; they fill in on a later read."}
        </p>
      )}
    </>
  );
}

/**
 * One event: when, what, and what it was worth.
 *
 * The date is the link out, matching the trade list — on a page about one wallet the
 * useful thing to do with a row is check it against the chain, and the timestamp is the
 * part of the row that is ours rather than the chain's.
 *
 * A row worth zero is rendered as zero and dimmed, not hidden. The two ways that happens
 * both mean something: a referral that has not cleared the activity bar is a real event
 * that has not paid yet and might, and a rate set to zero is a real rate. Dropping either
 * would make the list stop being the thing the total can be checked against.
 */
function EventRow({ event: e }: { event: PointEvent }) {
  const chainId = useHydratedChainId();
  const explorer = chainById(chainId)?.blockExplorers?.default.url;
  const { what, note } = describe(e);

  const when = e.at ? dateOf(e.at) : `#${e.block.toLocaleString()}`;
  const title = e.at
    ? new Date(e.at * 1000).toLocaleString()
    : `Block ${e.block.toLocaleString()} — its timestamp hasn't been read yet`;

  return (
    <div className="pts-ev">
      <span className="pts-ev-when">
        {explorer && e.txHash !== "0x" ? (
          <a
            className="link"
            href={`${explorer}/tx/${e.txHash}`}
            target="_blank"
            rel="noreferrer"
            title={title}
          >
            {when}
          </a>
        ) : (
          <span title={title}>{when}</span>
        )}
      </span>

      <span className="pts-ev-what">
        {what}
        {note && <span className="pts-ev-note">{note}</span>}
      </span>

      <span className={`pts-ev-n ${e.points > 0n ? "gold" : "dim"}`}>
        {e.points > 0n ? `+${fmtPoints(e.points)}` : fmtPoints(e.points)}
      </span>
    </div>
  );
}

/**
 * A log turned into a sentence, plus the qualifier that keeps it honest.
 *
 * Named by what the wallet did, not by which contract emitted it: "Launched FOO" rather
 * than "TokenCreated". The token is a link where one exists, because a row about a token
 * is the shortest path back to that token's page.
 */
function describe(e: PointEvent): { what: React.ReactNode; note?: string } {
  switch (e.kind) {
    case "register":
      return { what: "Registered for the waterdrop", note: "once per wallet" };

    case "referral":
      return {
        what: (
          <>
            Referral <Ticker>{e.referee ? shortAddr(e.referee) : "a wallet"}</Ticker>
          </>
        ),
        // The one row whose value can change without anything new happening on chain, so
        // it says which of the two zeroes it is: not checked yet, or does not qualify.
        note: e.pending ? "not cleared the activity bar yet" : "cleared",
      };

    case "create":
      return {
        what: (
          <>
            Launched <TokenLink token={e.token} symbol={e.symbol} />
          </>
        ),
      };

    case "trade":
      return {
        what: (
          <>
            {e.isBuy === false ? "Sold" : "Bought"}{" "}
            <TokenLink token={e.token} symbol={e.symbol} />
          </>
        ),
        note: e.venue === "pool" ? "on the pool" : "on the curve",
      };

    case "coupon":
      return { what: "Coupon redeemed" };

    case "grant":
      return { what: "Grant", note: e.reason || undefined };
  }
}

/** A token by ticker where we could read one, by address where we could not. */
function TokenLink({ token, symbol }: { token?: Address; symbol?: string }) {
  const label = symbol || (token ? shortAddr(token) : "a token");
  if (!token) return <Ticker>{label}</Ticker>;
  return (
    <Link href={`/token/${token}`} className="link">
      <Ticker>{label}</Ticker>
    </Link>
  );
}

/** The one emphasised word in a row: a ticker, or the wallet a referral was for. */
function Ticker({ children }: { children: React.ReactNode }) {
  return <b className="pts-ev-who">{children}</b>;
}

/**
 * `12 Aug`, or `12 Aug 2025` when it was not this year.
 *
 * A date rather than the `fmtAge` the trade list uses. Ages are for a feed being watched
 * live, where "3m ago" is the useful fact; this list spans a wallet's entire history, and
 * "412d" is a number nobody can place. The exact time rides along in the `title`.
 */
function dateOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
