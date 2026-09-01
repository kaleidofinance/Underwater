import { ponder } from "ponder:registry";
import { registration } from "ponder:schema";
import { zeroAddress } from "viem";
import { credit, enrol } from "./points";

/**
 * The waitlist, which is half the uwPoints inputs in a single event.
 *
 * `Registered(who, position, at, referrer)` carries two facts the rate card prices
 * separately: the registration itself, credited to `who`, and a referral, credited to
 * `referrer`. The app reads it twice for that reason — once unfiltered for registrations
 * and once by the indexed `referrer` topic — where here one handler writes both sides.
 *
 * `position` is the 1-based arrival order and it comes out of the log rather than being
 * counted here, which matters for correctness rather than convenience: a count kept in
 * this process would be wrong for any wallet that registered below the start block, and
 * the number the log carries is the number the contract assigned.
 */
ponder.on("Waitlist:Registered", async ({ event, context }) => {
  const chainId = context.chain.id;
  const { who, position, at } = event.args;

  // `address(0)` is the event's "no referrer", and self-referral reverts in the contract
  // (UnderwaterWaitlist.sol) — so the second check defends against nothing today and
  // costs a comparison. It stays because a self-referral would credit a wallet for
  // arriving, on top of the registration it is already credited for, and the shape of
  // that bug is a leaderboard nobody can explain.
  const referrer =
    event.args.referrer === zeroAddress || event.args.referrer === who
      ? null
      : event.args.referrer;

  await context.db.insert(registration).values({
    chainId,
    who,
    position,
    at: Number(at),
    referrer,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
  });

  await enrol(context.db, chainId, who, { position, at: Number(at), referrer });

  if (referrer) await credit(context.db, chainId, referrer, { referrals: 1 });
});
