import { createConfig, factory } from "ponder";
import { parseAbiItem, type Address } from "viem";
import { launchpadAbi, pairAbi } from "./abis/generated";

/**
 * What the indexer watches, and on which chains.
 *
 * Built from the environment rather than written out, for the same reason the app's
 * chain registry is: a network can have the launchpad deployed or not, and every
 * table keyed by chain id is a place to forget one. A chain with no
 * `LAUNCHPAD_<KEY>` is simply absent from this config, which is the honest state —
 * Ponder would otherwise start, connect, and index nothing while looking healthy.
 *
 * The cost of building it dynamically is that `context.chain.name` widens to
 * `string` instead of a union of the configured names. That is fine here because no
 * handler branches on the name; they use `context.chain.id`, which is what the tables
 * are keyed by anyway. Contract *names* stay literal, so `ponder.on("Launchpad:Trade")`
 * is still checked against the ABI.
 */
type Net = {
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

const NETWORKS: readonly Net[] = [
  { name: "ink", id: 57073, key: "INK", logRange: 9_000 },
  { name: "inkSepolia", id: 763373, key: "INK_SEPOLIA", logRange: 9_000 },
  { name: "robinhood", id: 4663, key: "ROBINHOOD" },
  { name: "robinhoodTestnet", id: 46630, key: "ROBINHOOD_TESTNET" },
  { name: "anvil", id: 31337, key: "ANVIL", local: true },
];

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
function launchpadFor(key: string): Address | null {
  const raw =
    process.env[`LAUNCHPAD_${key}`] ?? process.env[`NEXT_PUBLIC_LAUNCHPAD_${key}`];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  if (/^0x0{40}$/.test(trimmed)) return null;
  return trimmed as Address;
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
function startBlockFor(key: string): number {
  const raw =
    process.env[`START_BLOCK_${key}`] ?? process.env[`POINTS_FROM_BLOCK_${key}`];
  const n = raw ? Number(raw.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
function rpcFor(key: string): string[] {
  const raw = process.env[`${key}_RPC_URL`];
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^(https?|wss?):\/\/[^\s/]+/i.test(part));
}

const configured = NETWORKS.flatMap((net) => {
  const launchpad = launchpadFor(net.key);
  if (!launchpad) return [];
  const rpc = rpcFor(net.key);
  if (rpc.length === 0) {
    throw new Error(
      `${net.key} has a launchpad configured but no ${net.key}_RPC_URL. ` +
        `Name the endpoint the backfill should use, public or not — see rpcFor in ponder.config.ts.`,
    );
  }
  return [{ ...net, launchpad, rpc, startBlock: startBlockFor(net.key) }];
});

if (configured.length === 0) {
  throw new Error(
    "No chains configured. Set LAUNCHPAD_<KEY> and <KEY>_RPC_URL for at least one " +
      "network, or copy web/.env.local into indexer/.env.local. See README.md.",
  );
}

console.log(
  `indexing ${configured.map((c) => `${c.name}@${c.startBlock}`).join(", ")}`,
);

const chains = Object.fromEntries(
  configured.map((c) => [
    c.name,
    {
      id: c.id,
      rpc: c.rpc,
      ...(c.logRange ? { ethGetLogsBlockRange: c.logRange } : {}),
      ...(c.local ? { disableCache: true } : {}),
    },
  ]),
);

const launchpadChains = Object.fromEntries(
  configured.map((c) => [c.name, { address: c.launchpad, startBlock: c.startBlock }]),
);

/**
 * Every pair a launch has graduated into — discovered from the launchpad, not the DEX
 * factory.
 *
 * `Graduated(address indexed token, address indexed pair, …)` names the pair
 * explicitly, which makes it a better factory event than the DEX's own
 * `PairCreated`: the factory is a public AMM and anyone may create a pair on it, so
 * `PairCreated` would enrol pools that have nothing to do with a launch and then need
 * filtering back out. Taking the address from the graduation link means the set is
 * exactly the launches, by construction, and it needs no factory address in the
 * environment at all.
 *
 * `pair` is an indexed parameter, so Ponder reads it out of topic 2 rather than
 * decoding the data — the `parameter` name is all it needs either way.
 *
 * The event is declared here as a string rather than pulled out of `launchpadAbi`
 * because `parseAbiItem` is what Ponder's `factory()` wants and the ABI is a
 * generated blob; if the event signature ever changes, this line stops matching and
 * no pairs are found — loudly enough, since a graduated token's chart would flatline
 * on the day of the change.
 */
const GRADUATED = parseAbiItem(
  "event Graduated(address indexed token, address indexed pair, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 protocolFee, uint256 timestamp)",
);

const pairChains = Object.fromEntries(
  configured.map((c) => [
    c.name,
    {
      address: factory({
        address: c.launchpad,
        event: GRADUATED,
        parameter: "pair",
      }),
      startBlock: c.startBlock,
    },
  ]),
);

export default createConfig({
  // "multichain" is the default and the right one here: our chains are independent
  // deployments with no cross-chain reads, so there is nothing to gain from making
  // every chain wait for the slowest one's blocks the way "omnichain" does.
  ordering: "multichain",
  chains,
  contracts: {
    Launchpad: { abi: launchpadAbi, chain: launchpadChains },
    Pair: { abi: pairAbi, chain: pairChains },
  },
});
