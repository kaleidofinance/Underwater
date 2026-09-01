import type { Address } from "viem";

/**
 * Which networks this indexer can be pointed at, and how one is configured.
 *
 * Lifted out of `ponder.config.ts` because two things need it now. The config builds
 * Ponder's chain and contract maps from it, as before; the API needs it to answer a
 * question the tables cannot — *is this chain one I index at all?* A `SELECT` over an
 * unconfigured chain returns no rows, which is indistinguishable from a chain that is
 * indexed and has had no launches, and the difference matters to the caller: one means
 * "ask somebody else", the other means "there is nothing to show". See `/chains` in
 * `src/api/index.ts`.
 *
 * Deliberately not a re-read of Ponder's own config object. `createConfig` returns
 * chain and contract maps keyed by name with the start blocks buried inside
 * `contracts.Launchpad.chain`, so recovering this from there is an untyped traversal of
 * a shape that belongs to Ponder. The network table is ours, so it is what gets shared.
 */

export type Net = {
  /** The Ponder chain name. Only ever seen in logs and in `context.chain.name`. */
  name: string;
  id: number;
  /**
   * The env suffix, which is the same word `foundry.toml`, the deploy scripts and
   * the frontend use — see `Network.key` in web/lib/chains.ts. One word names the
   * network across the repo, so `INK_RPC_URL` in web/.env.local is the same variable
   * this reads.
   */
  key: string;
  /**
   * Blocks per `eth_getLogs`, or undefined to let Ponder infer it.
   *
   * Ink's public endpoints refuse anything wider than ten thousand blocks outright
   * (`block range greater than 10000 max`), so they are told nine thousand up front
   * rather than discovering it from an error on the first request. Robinhood's
   * enforce no range limit at all — they cap *matched logs* instead, which is not a
   * number expressible here, so those chains are left to Ponder's own backoff.
   *
   * This mirrors `Network.logChunk` in web/lib/chains.ts, which is the same fact
   * measured for the same endpoints.
   */
  logRange?: number;
  /**
   * Anvil, where the RPC cache has to be off: it keys on chain id and block number,
   * and a local node that gets restarted reuses both for entirely different chains.
   */
  local?: true;
};

export const NETWORKS: readonly Net[] = [
  { name: "ink", id: 57073, key: "INK", logRange: 9_000 },
  { name: "inkSepolia", id: 763373, key: "INK_SEPOLIA", logRange: 9_000 },
  { name: "robinhood", id: 4663, key: "ROBINHOOD" },
  { name: "robinhoodTestnet", id: 46630, key: "ROBINHOOD_TESTNET" },
  { name: "anvil", id: 31337, key: "ANVIL", local: true },
];

/** A network with a launchpad and an endpoint — one this process actually indexes. */
export type Configured = Net & {
  launchpad: Address;
  /**
   * The waitlist and the points contract, where they are deployed here.
   *
   * Null is an ordinary state rather than a misconfiguration, and both of them occur:
   * Robinhood has a points contract and no waitlist, because the plates allowlist is an
   * Ink thing. A chain missing one simply has no rows from it, and the app checks these
   * against its own addresses before reading a balance from here — an indexer that does
   * not watch the waitlist would serve totals missing every registration, which is a
   * wrong number rather than an absent one. See `/chains` in src/api/index.ts.
   */
  waitlist: Address | null;
  points: Address | null;
  rpc: string[];
  startBlock: number;
  /** Where the points streams start — see `pointsBlockFor`. */
  pointsBlock: number;
};

/**
 * A deployment address out of the environment, or null.
 *
 * Accepts the frontend's `NEXT_PUBLIC_`-prefixed name as well as the bare one, so a
 * single env file can serve both packages — copy web/.env.local next to this and the
 * indexer finds the same launchpads the app is pointed at. The bare name wins when
 * both are set, which is what lets an indexer be aimed somewhere else deliberately.
 *
 * Guards the failure modes a hand-edited env file has, exactly as `envAddress` in
 * web/lib/chains.ts does: a blank variable, a placeholder zero address, a stray
 * newline from a shell heredoc.
 */
function deploymentFor(what: string, key: string): Address | null {
  const raw = process.env[`${what}_${key}`] ?? process.env[`NEXT_PUBLIC_${what}_${key}`];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  if (/^0x0{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

/** The launchpad, which is what decides whether a chain is indexed at all. */
export function launchpadFor(key: string): Address | null {
  return deploymentFor("LAUNCHPAD", key);
}

/** The waitlist, source of `Registered` — registrations and referrals. */
export function waitlistFor(key: string): Address | null {
  return deploymentFor("WAITLIST", key);
}

/** The points contract, source of `Redeemed` and `Granted`. */
export function pointsFor(key: string): Address | null {
  return deploymentFor("POINTS", key);
}

/** A block number out of one variable, or null when it is unset or not a block. */
function blockFor(name: string): number | null {
  const raw = process.env[name];
  const n = raw ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The block the launchpad was deployed in, or 0.
 *
 * Zero is correct but expensive: it walks the chain from genesis to find the first
 * `TokenCreated`, which on a 0.1-second chain is millions of empty blocks. Set
 * `START_BLOCK_<KEY>` to the deploy block and the backfill starts where the history
 * does. `POINTS_FROM_BLOCK_<KEY>` in web/lib/points.ts is the same number for the
 * same reason, and can be copied straight across when the two deploys were together.
 */
export function startBlockFor(key: string): number {
  return blockFor(`START_BLOCK_${key}`) ?? blockFor(`POINTS_FROM_BLOCK_${key}`) ?? 0;
}

/**
 * Where the points streams start — the lower of the two floors, not the launchpad's.
 *
 * The waitlist and the points contract are separate deploys from the launchpad, and on
 * Ink Sepolia they went out together so both variables hold the same block. The minimum
 * is taken because the failure otherwise is silent: `START_BLOCK_<KEY>` moving up after
 * a launchpad redeploy would drop every registration below it, and a balance short by a
 * `register` rate looks exactly like a wallet that never registered. Reading low costs
 * a wider backfill over two contracts with a handful of logs between them; reading high
 * costs a wrong number that nothing detects.
 *
 * `POINTS_FROM_BLOCK_<KEY>` is the app's own scan floor (`pointsFromBlock` in
 * web/lib/points.ts), so honouring it here is what makes the indexed total and the RPC
 * total the same total — which is the whole premise of serving one as a substitute for
 * the other.
 */
export function pointsBlockFor(key: string): number {
  const start = blockFor(`START_BLOCK_${key}`);
  const points = blockFor(`POINTS_FROM_BLOCK_${key}`);
  if (start === null) return points ?? 0;
  if (points === null) return start;
  return Math.min(start, points);
}

/**
 * The endpoints for a chain, best first.
 *
 * The same `<KEY>_RPC_URL` convention the app's `serverEndpoints` uses, and the same
 * comma-separated form, so one variable configures both. Ponder takes a list and fails
 * over across it.
 *
 * A chain with no override throws rather than falling back to the public endpoint — but
 * not because a public endpoint cannot serve a backfill. Ink Sepolia's 563,580 blocks
 * from the deploy block completed in 2m 45s against `rpc-gel-sepolia.inkonchain.com`,
 * absorbing 26 `-32016` rate-limit errors through Ponder's own retry. The reason is that
 * which endpoint a backfill hammers should be a decision somebody made rather than a
 * default, and the same run against a mainnet with real history is a different order of
 * magnitude. There is also no throttle to reach for if the retries are not enough:
 * `maxRequestsPerSecond` still type-checks in 0.17 but is deprecated and appears nowhere
 * in the compiled output, so the backoff is the entire rate strategy.
 */
export function rpcFor(key: string): string[] {
  const raw = process.env[`${key}_RPC_URL`];
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^(https?|wss?):\/\/[^\s/]+/i.test(part));
}

/**
 * Every network this process indexes, read from the environment.
 *
 * Throws rather than returning an empty list, and throws on a launchpad with no
 * endpoint, because both are configuration mistakes that would otherwise produce a
 * process that starts, connects, and indexes nothing while looking healthy.
 *
 * Called by the config at build time and by the API at request time. The two run in the
 * same process off the same environment, so they cannot disagree — and because the
 * result is derived rather than stored, adding a chain to the service is a variable and
 * not a deploy of two files that have to match.
 */
export function configuredNetworks(): readonly Configured[] {
  const configured = NETWORKS.flatMap((net): Configured[] => {
    const launchpad = launchpadFor(net.key);
    if (!launchpad) return [];
    const rpc = rpcFor(net.key);
    if (rpc.length === 0) {
      throw new Error(
        `${net.key} has a launchpad configured but no ${net.key}_RPC_URL. ` +
          `Name the endpoint the backfill should use, public or not — see rpcFor in networks.ts.`,
      );
    }
    return [
      {
        ...net,
        launchpad,
        waitlist: waitlistFor(net.key),
        points: pointsFor(net.key),
        rpc,
        startBlock: startBlockFor(net.key),
        pointsBlock: pointsBlockFor(net.key),
      },
    ];
  });

  if (configured.length === 0) {
    throw new Error(
      "No chains configured. Set LAUNCHPAD_<KEY> and <KEY>_RPC_URL for at least one " +
        "network, or copy web/.env.local into indexer/.env.local. See README.md.",
    );
  }

  return configured;
}
