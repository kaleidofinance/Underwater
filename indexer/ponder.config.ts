import { createConfig, factory } from "ponder";
import { parseAbiItem } from "viem";
import { launchpadAbi, pairAbi } from "./abis/generated";
import { configuredNetworks } from "./networks";

/**
 * What the indexer watches, and on which chains.
 *
 * Built from the environment rather than written out, for the same reason the app's
 * chain registry is: a network can have the launchpad deployed or not, and every
 * table keyed by chain id is a place to forget one. A chain with no
 * `LAUNCHPAD_<KEY>` is simply absent from this config, which is the honest state —
 * Ponder would otherwise start, connect, and index nothing while looking healthy.
 * The network table and the environment reading are in `networks.ts`, because the API
 * needs the same answer — see the note there.
 *
 * The cost of building it dynamically is that `context.chain.name` widens to
 * `string` instead of a union of the configured names. That is fine here because no
 * handler branches on the name; they use `context.chain.id`, which is what the tables
 * are keyed by anyway. Contract *names* stay literal, so `ponder.on("Launchpad:Trade")`
 * is still checked against the ABI.
 */
const configured = configuredNetworks();

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
