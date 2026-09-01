import type { Address } from "viem";
import { blockSeconds, declaredDeployBlock, networkFor } from "./chains";
import { cached, type ServerClient } from "./server-rpc";

/**
 * Reading a range of logs that is wider than the RPC will serve in one go.
 *
 * The scans used to ask for a hundred thousand blocks and quietly settle for nine,
 * because Ink's public endpoints answer anything wider than ten thousand with
 * `block range greater than 10000 max`. Nine thousand blocks is two and a half hours
 * of a one-second chain, so "market volume" meant the last two and a half hours of
 * it and a token's history began wherever that window happened to land.
 *
 * The fix is not a wider window, it is more requests — which was unaffordable while
 * every tab ran its own scan and is affordable now that one cached read serves
 * everybody. So a range is split into chunks the endpoint will accept and walked with
 * bounded concurrency.
 *
 * What makes that finite is knowing where to stop. History does not start at genesis,
 * it starts at the block the launchpad was deployed in: there is no `Trade` before
 * the contract that emits it, and no pair either, since the launchpad creates them.
 * On Ink Sepolia that floor is block 58,643,112, which is 43 chunks behind the head —
 * a number a route can cover in one read and then never re-read, because logs in a
 * settled range do not change.
 *
 * Both of those numbers are per chain now — see {@link scanPolicy}. Ink produces a
 * block a second and Robinhood Chain produces ten, so a chunk width and a reorg tail
 * written as block counts mean entirely different amounts of history on the two, and
 * the ones tuned here for Ink were three-quarters of a minute of the other.
 */

/**
 * How much of the head is treated as unsettled, in seconds.
 *
 * An L2's recent blocks are not final — the sequencer can replace them — so a log
 * cached the moment it appeared can turn out never to have happened. Everything
 * older than this is treated as settled and cached forever; everything newer is
 * fetched fresh every time, which costs exactly one chunk.
 *
 * Five minutes. Far past anything either chain has actually reorged, and cheap
 * enough that being generous costs nothing. In *seconds* rather than blocks because
 * that is what the property actually is: five minutes of Ink is 300 blocks and five
 * minutes of Robinhood Chain is 3,000, and the same constant used as a block count
 * on both would give the faster chain a forty-four second tail.
 */
const REORG_SECONDS = 300;

/** How many chunk requests are allowed in flight at once. */
export const LANES = 6;

/** The two block counts a scan needs, for one chain. */
export type ScanPolicy = {
  /** Blocks per `eth_getLogs`. */
  chunk: bigint;
  /** Blocks at the head re-read on every scan instead of being kept. */
  reorgTail: bigint;
};

/**
 * What a scan of this chain may ask for, and how much of the head it may not trust.
 *
 * Both come from the registry in lib/chains.ts: the chunk width is a fact about what
 * the endpoints will serve, and the tail is {@link REORG_SECONDS} converted through
 * the chain's own declared block time — the same declaration the market cards read to
 * put a window in hours. Falls back to Ink's numbers for an unknown id, which the
 * routes cannot actually reach — `chainFrom` rejects anything outside the registry
 * before a scan is built — so the fallback is a default rather than a policy.
 */
export function scanPolicy(chainId: number): ScanPolicy {
  const net = networkFor(chainId);
  return {
    chunk: net?.logChunk ?? 9_000n,
    reorgTail: BigInt(Math.ceil(REORG_SECONDS / blockSeconds(net))),
  };
}

/**
 * Furthest back a scan will look when the deployment block cannot be found.
 *
 * Only reachable if `eth_getCode` at an old block is refused — a pruned node, which
 * the public endpoints are not but a self-hosted one might be. Wide enough to be
 * useful, finite enough that a bad answer cannot turn into an unbounded scan.
 *
 * Being finite is the point, and being *wrong* is the cost: this window is a guess
 * about where history starts, and a guess that lands after the first log reports an
 * empty history rather than an incomplete one. Robinhood Testnet is a pruned node in
 * practice and that is exactly what happened there, which is what
 * `Network.deployedAt` exists to fix — a chain that cannot be asked can still be
 * *told*, and being told is the only way `exact` comes back true.
 */
const MAX_LOOKBACK = 1_000_000n;

/**
 * `eth_getCode` probes issued per round trip while locating a deployment.
 *
 * A plain bisection asks about one block per round trip, which on a chain fifty million
 * blocks tall is thirty sequential requests to a public endpoint — measured at 23
 * seconds, all of it paid by the first request to reach a cold instance, and on its own
 * most of a read that is supposed to feel immediate. It was also the whole of that first
 * request: the log scan beside it was fourteen requests.
 *
 * But {@link ServerClient} batches everything issued in one tick into a single POST, so
 * probing several blocks costs one round trip and narrows the bracket by
 * `PROBES + 1` rather than halving it. Swept against `rpc-gel-sepolia`, locating this
 * launchpad 392,000 blocks behind the head:
 *
 * ```
 * PROBES= 1   5695ms  21 rounds   32 probes  0.79 MB
 * PROBES= 4   2365ms  10 rounds   45 probes  0.88 MB
 * PROBES= 8   2712ms   8 rounds   61 probes  1.04 MB
 * PROBES=16   3344ms   6 rounds   84 probes  2.09 MB
 * ```
 *
 * So it is not simply round-trip bound: `eth_getCode` replies with the whole runtime
 * bytecode — 42 KB for the launchpad — and past four the extra probes cost more on the
 * wire than the round trip they save. Four is where the two meet, and it is a
 * comfortable place to sit rather than a cliff edge: every width in the sweep found the
 * same block, so this trades speed only.
 */
const PROBES = 4;

/**
 * The block a contract first had code in.
 *
 * A widening search on `eth_getCode` — see {@link PROBES} for the shape of it — paid
 * once per process, since the answer is a property of a deployment and cannot change.
 * This is the floor every scan measures from, and deriving it from the address rather
 * than configuration is deliberate: a `FROM_BLOCK` env var is one more thing that can
 * be left pointing at the previous deployment, and the failure that produces is a
 * history that silently starts late.
 *
 * A chain whose endpoint will not answer for old blocks cannot be searched at all,
 * though, and there the choice is not between asking and being told but between being
 * told and guessing. `Network.deployedAt` is the being-told case: consulted first,
 * keyed by address so it keeps the property this note is defending, and documented
 * there. When it has an entry the search is skipped entirely — which is also why this
 * stays cheap on the chain that most needed it, since a search that is going to fail
 * still costs the round trips it fails on.
 *
 * `exact` is false when the search had to give up and fall back to a fixed lookback,
 * which is the difference between a scan that can honestly call itself complete and
 * one that merely covers a lot. Callers report it rather than assuming.
 */
export type Floor = { block: bigint; exact: boolean };

export function deployBlock(
  client: ServerClient,
  chainId: number,
  address: Address,
  head: bigint,
): Promise<Floor> {
  return cached<Floor>(`deploy:${chainId}:${address.toLowerCase()}`, Infinity, () =>
    findDeploy(client, chainId, address, head),
  ).then(({ value }) => value);
}

async function findDeploy(
  client: ServerClient,
  chainId: number,
  address: Address,
  head: bigint,
): Promise<Floor> {
  // Told, asked, or guessed, in that order of preference. A declared block is both the
  // floor and the answer; without one the floor is only a bound on the search.
  const declared = declaredDeployBlock(chainId, address);
  const floor = declared ?? (head > MAX_LOOKBACK ? head - MAX_LOOKBACK : 0n);
  const started = Date.now();
  let probes = 0;
  let rounds = 0;
  const has = async (blockNumber: bigint) => {
    const code = await client.getCode({ address, blockNumber });
    return !!code && code !== "0x";
  };
  // Created in one tick, so `batch: true` sends them as one POST and the whole list
  // costs a single round trip.
  const hasAll = (blocks: readonly bigint[]) => {
    probes += blocks.length;
    rounds++;
    return Promise.all(blocks.map(has));
  };

  try {
    if (declared !== null) {
      // Nothing to search for, but still worth one probe at the head: it is the only
      // thing separating "deployed, no trades yet" from "this chain's address points at
      // nothing", and the callers' contract reads depend on the difference. The head is
      // recent by definition, so it is the one block a pruned node will answer for.
      if (!(await hasAll([head]))[0]) {
        throw new NotDeployed(`${address} has no code at block ${head}`);
      }
      console.log(
        `[chunks] ${address} declared deployed at block ${declared}, ${head - declared} behind the head — no search, ${Date.now() - started}ms`,
      );
      return { block: declared, exact: true };
    }

    // The head and the widening steps back from it, in one round trip. A contract
    // deployed recently is bracketed by the near probes and an old one by the far ones,
    // and the head's own probe rides along instead of costing a round trip of its own
    // just to establish that the contract is there.
    const steps: bigint[] = [head];
    for (let step = 1n; head - step > floor; step *= 4n) steps.push(head - step);
    steps.push(floor);

    const bracketed = await hasAll(steps);
    if (!bracketed[0]) {
      // Configured but not deployed on this chain. The callers' contract reads are
      // about to fail too, so say so rather than scanning a million empty blocks.
      throw new NotDeployed(`${address} has no code at block ${head}`);
    }

    // `steps` descends, so the deployment sits between the deepest probe that still
    // has code and the first one that does not.
    let lo = floor;
    let hi = head;
    for (let i = 1; i < steps.length; i++) {
      if (!bracketed[i]) {
        lo = steps[i];
        break;
      }
      hi = steps[i];
    }
    if (hi <= floor) {
      // Code as far back as we are willing to look. The contract is older than
      // `MAX_LOOKBACK`, so this floor is a bound rather than the answer, and a scan
      // measuring from it must not call itself complete.
      return { block: floor, exact: false };
    }

    // Narrow with `PROBES` evenly spaced cuts per round trip, so the bracket shrinks
    // by a factor of `PROBES + 1` each time instead of halving.
    const parts = BigInt(PROBES + 1);
    while (lo + 1n < hi) {
      const span = hi - lo;
      const cuts: bigint[] = [];
      for (let k = 1n; k <= BigInt(PROBES); k++) {
        const at = lo + (span * k) / parts;
        // Strictly inside the bracket, and each one past the last — on a narrow span
        // the arithmetic repeats itself, and a probe we already know the answer to is
        // a wasted slot in the batch.
        if (at > lo && at < hi && (!cuts.length || at > cuts[cuts.length - 1])) {
          cuts.push(at);
        }
      }
      if (!cuts.length) break;

      const found = await hasAll(cuts);
      // Ascending this time: the last cut without code, and the first cut with it.
      let next = hi;
      for (let i = 0; i < cuts.length; i++) {
        if (found[i]) {
          next = cuts[i];
          break;
        }
        lo = cuts[i];
      }
      hi = next;
    }
    // Once per process, and the one number every scan's range is measured from — so
    // it is worth being able to see that it was found, and what it cost.
    console.log(
      `[chunks] ${address} deployed at block ${hi}, ${head - hi} behind the head — ${probes} probes in ${rounds} round trips, ${Date.now() - started}ms`,
    );
    return { block: hi, exact: true };
  } catch (e) {
    if (e instanceof NotDeployed) throw e;
    // A node that will not answer for old blocks. A bounded lookback is wrong but
    // usable; refusing to scan at all is neither. Unless the block was declared, in
    // which case this is the expected path on a pruned chain rather than a degradation:
    // the floor is already the answer, and only the head probe was lost.
    console.warn(
      declared !== null
        ? `[chunks] could not confirm ${address} at the head, trusting its declared block ${declared}:`
        : `[chunks] could not locate ${address}'s deployment, falling back to ${MAX_LOOKBACK} blocks:`,
      e instanceof Error ? e.message : e,
    );
    return { block: floor, exact: declared !== null };
  }
}

class NotDeployed extends Error {}

export type Range = { from: bigint; to: bigint };

/**
 * Inclusive ranges of at most `chunk` blocks, oldest first.
 *
 * `chunk` is required rather than defaulted, because a default is how a caller ends
 * up asking a 0.1-second chain for Ink's window without saying so. It comes from
 * {@link scanPolicy}.
 */
export function ranges(from: bigint, to: bigint, chunk: bigint): Range[] {
  const out: Range[] = [];
  if (to < from) return out;
  for (let start = from; start <= to; start += chunk) {
    const end = start + chunk - 1n;
    out.push({ from: start, to: end > to ? to : end });
  }
  return out;
}

/**
 * `fn` over every item, at most {@link LANES} at a time, results in input order.
 *
 * Not `Promise.all`: forty-three simultaneous `eth_getLogs` is how a public endpoint
 * decides it is being abused, and this codebase has already measured that one
 * dropping nineteen of forty batched calls. Not a sequential loop either, which
 * would make a cold scan forty-three round trips deep.
 */
export async function lanes<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit = LANES,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * Milliseconds the first wave gets even when the deadline has already passed.
 *
 * The invariant this protects: every read makes progress, so a caller resuming where
 * the last one stopped eventually converges. Without it a read whose pre-work overran
 * the budget — a cold instance's deployment search, measured at 31 seconds on a bad
 * minute — would do no scanning at all, and a route that never scans never finishes
 * reaching back.
 *
 * Four seconds because a wave of three chunks is about one second on this endpoint, and
 * a wave that cannot finish in four was not going to help this request anyway.
 */
const WAVE_GRACE = 4_000;

/** Thrown inside {@link newestChunksUntil} when a wave outlasts its deadline. */
class OutOfTime extends Error {}

/**
 * `promise`, or a rejection the moment `deadline` passes.
 *
 * A clock checked between waves is not a bound on its own: one `eth_getLogs` that hangs
 * until its timeout and then retries can outlast the whole budget by itself — measured
 * at 45 seconds for a single read against Ink's public endpoint on a bad minute, with a
 * seven-second budget set. So each wave is raced, and losing the race costs only that
 * wave. The abandoned request is left to finish into nothing, which costs a socket and
 * no correctness, because nothing has been committed at that point.
 */
function byDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OutOfTime()),
      Math.max(0, deadline - Date.now()),
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Newest chunks first, stopping as soon as `enough` says so or `deadline` passes.
 *
 * What makes a token's feed cheap: the page shows the most recent rows, so a busy
 * token is answered by the first chunk or two and only a quiet one is walked further
 * back. Concurrency means up to `limit - 1` chunks past the stopping point are read
 * anyway — worth it to keep the common case one round trip deep rather than several.
 *
 * Two independent reasons to stop, and they are kept apart deliberately. `enough` is
 * the semantic one — a caller filling a page says when it has enough rows. `deadline`
 * is the wall clock a route handler chooses to live inside so its answer stays prompt
 * (see the note on `REACH_MS` in /api/volume). A caller that wants only the clock passes
 * `() => false`.
 *
 * The clock is enforced *per chunk* rather than only between waves, which is the whole
 * point of it being here rather than in `enough`: a request left to its own timeout and
 * retries can outlast the budget several times over, and one that does is abandoned
 * instead of waited on — while the chunks beside it that did answer are kept. The first
 * wave is allowed {@link WAVE_GRACE} regardless, so a read always makes some progress.
 *
 * `reached` is the oldest block actually read, which is what a caller persists as the
 * bottom of its covered range — never the bottom of `all`, since the walk may have
 * stopped well above it, and never past a chunk the clock cut short.
 *
 * `ranOut` distinguishes the two ways of stopping early, for callers that log it. It
 * says nothing a caller needs for correctness: what was read is in `results` and how
 * far it got is `reached`, whichever reason ended the walk.
 */
export async function newestChunksUntil<R>(
  all: readonly Range[],
  fn: (range: Range) => Promise<R>,
  enough: (results: R[]) => boolean,
  limit = LANES,
  deadline?: number,
): Promise<{ results: R[]; reached: bigint; ranOut: boolean }> {
  const descending = all.slice().reverse();
  const results: R[] = [];
  let reached = all.length ? all[all.length - 1].from : 0n;
  let ranOut = false;

  for (let i = 0; i < descending.length; i += limit) {
    const wave = descending.slice(i, i + limit);
    const by =
      deadline === undefined
        ? undefined
        : i === 0
          ? Math.max(deadline, Date.now() + WAVE_GRACE)
          : deadline;

    // Raced per chunk rather than per wave. Racing the wave as a unit throws away
    // chunks that did finish because one beside them did not, which on a slow minute is
    // most of the work the read managed to do — and the walk resumes from `reached`
    // next time, so a discarded chunk is read again from scratch.
    const settled = await Promise.all(
      wave.map((r) => {
        const running = fn(r);
        if (by === undefined) return running.then((value) => ({ value, ok: true }));
        return byDeadline(running, by).then(
          (value) => ({ value, ok: true }),
          (e) => {
            // Only the clock is survivable. A chunk the endpoint refused is a hole in
            // the middle of a history, and the caller's whole read fails on it so that
            // nothing is committed — see the note in /api/volume. The one refusal that
            // is *not* a hole is "too many matched logs", which never reaches here:
            // `splitOnLogLimit` in lib/server-rpc.ts halves the range and retries, and
            // only a chunk that stays refused after that arrives as a real failure.
            if (!(e instanceof OutOfTime)) throw e;
            return { value: undefined as unknown as R, ok: false };
          },
        );
      }),
    );

    // Only the unbroken prefix counts: `reached` is the bottom of a *contiguous* range,
    // so a gap in the middle of a wave stops the walk there even if later chunks in it
    // came back.
    let taken = 0;
    while (taken < settled.length && settled[taken].ok) taken++;
    for (let k = 0; k < taken; k++) results.push(settled[k].value);
    if (taken > 0) reached = wave[taken - 1].from;

    if (taken < wave.length) {
      ranOut = true;
      break;
    }
    if (enough(results)) break;
  }
  return { results, reached, ranOut };
}
