import { defineChain, type Address, type Chain } from "viem";

/**
 * Multicall3, at the address it has on essentially every EVM chain.
 *
 * Load-bearing, and it was not always here. `useReadContracts` folds its reads
 * into one `aggregate3` when the chain declares this and issues one HTTP request
 * per read when it does not — and lib/refresh.ts invalidates every contract read
 * on every new block, which on a ~1s L2 polled every 2s is a fresh round of reads
 * twice a second. Unbatched, one idle tab is a few hundred `eth_call`s a minute,
 * and Ink's public gel RPC answers that with a 429 and a penalty box that outlasts
 * the interval which earned it.
 *
 * What that cost, on the one interface the public could reach at the time — the
 * pre-launch gate, since retired: its five waitlist reads failed together, every
 * field of `WaitlistState` fell back to its zero, and a zero `closesAt` is
 * `windowOf`'s `unconfigured` — which the live site rendered as "The waterdrop has
 * closed." over a registration window that was open, with three days left on it. A
 * read budget is not a performance concern here. It is whether the page is telling
 * the truth.
 *
 * It lived in lib/og-data.ts first, deliberately, on the reasoning that putting it
 * on the shared chain definitions would silently change how every hook in the app
 * reads, and would break the whole site rather than one image if the address were
 * ever wrong on some chain. The first half was exactly right and is now the point
 * — that change is wanted. The second half is why anvil does not get it.
 *
 * Verified live on both Ink chains 2026-08-28 and on both Robinhood chains
 * 2026-08-30: the same 3808-byte deployment on each. No `blockCreated`, which viem
 * only needs to read at a historical block; every read in this app is at `latest`.
 */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const MULTICALL = { multicall3: { address: MULTICALL3 } } as const;

/// Defined here rather than imported from viem/chains so the explorer URLs and
/// RPCs match the ones the contracts were tested against, independent of which
/// viem version is installed. Verified live 2026-08-23.
///
/// `name` is what the network switcher and every "not live on X yet" notice
/// render, so the two networks are named symmetrically — "Ink Mainnet" against
/// "Ink Sepolia", never a bare "Ink" that reads like it might be either. The
/// brand's marketing copy says "InkChain"; that is a separate register and does
/// not belong in a string a wallet shows.
///
/// Two RPCs each, in preference order, and both halves matter. The `qnd`
/// (QuickNode) endpoints are first because `gel` is the one that drops requests
/// under any sustained rate — see the note on MULTICALL3 for what that cost — and
/// `gel` stays second because a launchpad whose only RPC is having a bad day is a
/// dead site. app/providers.tsx builds a viem `fallback` transport straight off
/// this list, so adding or reordering an entry here is the whole change. Both
/// endpoints on both chains verified live 2026-08-28: correct `eth_chainId`, they
/// answer a JSON-RPC batch array, and they send `access-control-allow-origin`, so
/// the browser can use them and not just the server.
///
/// `blockTime` is declared because a block count is the only window a log scan can
/// report, and "last 86,400 blocks" is not a window anybody reads — the market cards
/// turn it back into hours off this number (see `useMarketVolume` in lib/stats.ts).
/// Both chains are OP-stack with a one-second block, measured 2026-08-30 as exactly
/// 10,000 seconds across 10,000 blocks on each, so this is a chain parameter and not
/// an estimate. viem's unit here is milliseconds. Declaring it changes nothing about
/// how this app transacts: `sendTransactionSync` is viem's only consumer of it, and
/// nothing here calls that.
export const ink = defineChain({
  id: 57073,
  name: "Ink Mainnet",
  blockTime: 1_000,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc-qnd.inkonchain.com", "https://rpc-gel.inkonchain.com"],
    },
  },
  blockExplorers: {
    default: { name: "Inkscan", url: "https://explorer.inkonchain.com" },
  },
  contracts: MULTICALL,
});

export const inkSepolia = defineChain({
  id: 763373,
  name: "Ink Sepolia",
  blockTime: 1_000,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc-qnd-sepolia.inkonchain.com",
        "https://rpc-gel-sepolia.inkonchain.com",
      ],
    },
  },
  blockExplorers: {
    default: {
      name: "Inkscan",
      url: "https://explorer-sepolia.inkonchain.com",
    },
  },
  contracts: MULTICALL,
  testnet: true,
});

/// Robinhood Chain, the second network this app is built for. An Arbitrum Nitro
/// chain rather than an OP Stack one, which is the only difference that reaches the
/// contracts: there is no `0x4200…0006` WETH predeploy, so `script/DeployDex.s.sol`
/// resolves WETH per chain id instead of assuming the OP address.
///
/// One RPC each, unlike the Ink pair, and that is a known weakness rather than an
/// oversight — the note above says why two matter. These are the only endpoints
/// that answer: `rpc.chain.robinhood.com` (what chainlist lists) does not resolve,
/// `robinhood-rpc.publicnode.com` does serve mainnet and is a candidate second
/// entry once it has been watched for a while, and no third-party testnet endpoint
/// was found at all. Both hosts verified live 2026-08-30: correct `eth_chainId`,
/// they answer a JSON-RPC batch array, and they send
/// `access-control-allow-origin: *` with a 204 preflight, so the browser can use
/// them directly.
///
/// The explorer is Blockscout on both, which is what `foundry.toml`'s `[etherscan]`
/// entries verify against. `explorer.mainnet.chain.robinhood.com` 301s to
/// `robinhoodchain.blockscout.com` and drops the query string doing it, so mainnet
/// names the redirect target directly; the testnet host serves its own API.
///
/// `blockTime` matters more here than it does on Ink, for the reason the note above
/// gives: a block count is the only window a log scan can report, and where "last
/// 86,400 blocks" is a day of Ink it is two and a half hours of this. Measured
/// 2026-08-30 over the last million blocks and again over the last thousand — a Nitro
/// chain's interval is set by its sequencer rather than by demand, so it does not
/// drift the way a PoS chain's does.
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  blockTime: 101,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: MULTICALL,
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  // 0.1461 s measured the same way; the explorer's own rolling average says 0.131.
  // Slower than mainnet and noisier, which is what a testnet's spare capacity looks
  // like.
  blockTime: 146,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  contracts: MULTICALL,
  testnet: true,
});

/// Local anvil, for developing against `npm run localchain` before anything is
/// deployed to a real network.
///
/// No `multicall3`, unlike the four above. Recent anvil predeploys one at the
/// canonical address, but "recent" is a fact about whichever foundry the person
/// running this happens to have, and a chain that claims a multicall3 it does not
/// have fails every batched read rather than falling back — the exact failure the
/// note on MULTICALL3 is about. Local dev has no rate limit to dodge, so there is
/// nothing to weigh against it.
///
/// No `blockTime` either, and for a similar reason: anvil mines on demand unless it
/// was started with `--block-time`, so there is no interval to declare. Callers that
/// want a window in hours fall back to stating blocks on this chain.
export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

// ─── The network registry ─────────────────────────────────────────────────────

/**
 * Everything that is true about one network, in one record.
 *
 * Adding a chain used to mean editing eight files that each kept their own
 * `Record<number, …>` keyed by chain id — the launchpad address in lib/contracts.ts,
 * the collection in lib/plates.ts, the waitlist in lib/waitlist-address.ts, the
 * points contract and its scan floor in lib/points.ts, the mark and the
 * mainnet/testnet label in components/ChainIcon.tsx, the transports in
 * app/providers.tsx. Every one of those tables was a place to forget the new chain,
 * and forgetting it does not fail the build: it silently reads as "not deployed
 * here", or labels a testnet "mainnet", which is the class of bug this app has
 * already shipped once (see MULTICALL3).
 *
 * So there is one table, and each of those modules reads through it.
 *
 * The addresses are written out as literal `process.env.NEXT_PUBLIC_*` references
 * rather than looked up by a constructed key, and that is not a style choice: Next
 * inlines exactly the `process.env.NEXT_PUBLIC_X` expressions it can see at build
 * time, so `process.env[`NEXT_PUBLIC_LAUNCHPAD_${key}`]` is `undefined` in the
 * browser and the whole app reads as undeployed. One line per deployment is the
 * price of that, and it is why the `key` field exists: it names the suffix, so the
 * variable a value came from is readable beside the network it belongs to.
 */
export type NetworkKind = "mainnet" | "testnet" | "local";

/**
 * The contracts configured on a network, resolved from the environment.
 *
 * Independent by design — a chain can have the launchpad and no points contract,
 * which is the state every chain is in between the two deploys. Each page reads the
 * one it needs and shows an honest "not deployed here" when it is null, rather than
 * firing calls at the zero address.
 */
export type Deployments = {
  launchpad: Address | null;
  plates: Address | null;
  waitlist: Address | null;
  points: Address | null;
};

export type Network = {
  chain: Chain;
  /**
   * The suffix this network's env vars use: `NEXT_PUBLIC_LAUNCHPAD_<KEY>`,
   * `POINTS_FROM_BLOCK_<KEY>`, `<KEY>_RPC_URL`. Also the `foundry.toml` profile
   * name and the `--rpc-url` alias, so one word names the network everywhere.
   */
  key: "INK" | "INK_SEPOLIA" | "ROBINHOOD" | "ROBINHOOD_TESTNET" | "ANVIL";
  kind: NetworkKind;
  /**
   * The mark shown beside the name, or null for a network with no artwork — which
   * renders the neutral square instead. See components/ChainIcon.tsx for why an
   * approximated trademark is not an option.
   */
  icon: string | null;
  /**
   * Blocks per `eth_getLogs`.
   *
   * Two different limits produce these numbers. Ink's public endpoints refuse
   * anything wider than ten thousand blocks outright (`block range greater than
   * 10000 max`), so nine thousand is that cap with room for the head moving.
   * Robinhood's enforce no range limit at all — a five-million-block request is
   * answered — but cap the *result* at ten thousand matched logs, which is a limit
   * on how much history a chunk covers rather than how many blocks it spans.
   *
   * So each entry is sized to cover about the same **two and a half hours** as Ink's
   * nine thousand blocks do. That keeps the log-density risk identical across
   * chains instead of introducing a new one on the faster chain, and it stops a
   * 0.1-second chain needing twenty-five times the requests to walk a day.
   *
   * Not derived from {@link blockSeconds}, though it is sized against it: what an
   * endpoint will serve is a fact about the endpoint, and the two happen to line up
   * here rather than one following from the other.
   */
  logChunk: bigint;
  deployments: Deployments;
};

/**
 * Seconds per block, from the chain's own declared `blockTime`.
 *
 * Every block-count budget in the log scanners is derived from this rather than
 * assumed, because the two chain families differ by an order of magnitude and a
 * constant tuned for one is wrong on the other: 300 blocks is five minutes of Ink and
 * forty-four seconds of Robinhood.
 *
 * Read off the viem chain rather than restated as a registry field, which it briefly
 * was. `blockTime` is already declared there for the market cards — `useMarketVolume`
 * in lib/stats.ts turns a block count into hours with it — and the same physical fact
 * written down twice is the kind of pair that agrees until someone edits one of them.
 *
 * One second for a chain that declares nothing, which is anvil: it mines on demand,
 * so there is no interval to read, and one second is what `--block-time 1` gives it
 * and what `npm run localchain` asks for.
 */
export function blockSeconds(net: Network | undefined): number {
  const ms = net?.chain.blockTime;
  return ms ? ms / 1000 : 1;
}

/**
 * A deployment address out of the environment, or null.
 *
 * Guards the failure modes a hand-edited `.env` has: a blank variable, a
 * placeholder left as the zero address, a value with a stray newline from a shell
 * heredoc. One guard for every address in the table below.
 */
export function envAddress(value: string | undefined): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  if (/^0x0{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

/**
 * Every network this app serves, in the order the switcher lists them.
 *
 * Ink Mainnet is first because `chainFrom` in lib/server-rpc.ts treats
 * `CHAINS[0]` as the default a route answers for when the request names no chain,
 * and that has to stay the network the app itself opens on.
 *
 * **Which systems travel.** The launchpad, the DEX and uwPoints are chain-agnostic
 * and get an env var on every network. The plates collection and the waitlist do
 * not travel, and their entries are hard `null` rather than an unread variable:
 * `UnderwaterPlates` draws its art from Aave V3 health factors and there is no Aave
 * V3 on Robinhood, so the contract cannot function there at all, and the waitlist
 * is a single launch event tied to one chain rather than a system with an instance
 * per network. A null here is a statement that the deployment is impossible or
 * meaningless, not that it has not happened yet.
 */
export const NETWORKS: readonly Network[] = [
  {
    chain: ink,
    key: "INK",
    kind: "mainnet",
    icon: "/chains/ink.png",
    logChunk: 9_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_INK),
      plates: envAddress(process.env.NEXT_PUBLIC_PLATES_INK),
      waitlist: envAddress(process.env.NEXT_PUBLIC_WAITLIST_INK),
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_INK),
    },
  },
  {
    chain: inkSepolia,
    key: "INK_SEPOLIA",
    kind: "testnet",
    icon: "/chains/ink.png",
    logChunk: 9_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_INK_SEPOLIA),
      plates: envAddress(process.env.NEXT_PUBLIC_PLATES_INK_SEPOLIA),
      waitlist: envAddress(process.env.NEXT_PUBLIC_WAITLIST_INK_SEPOLIA),
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_INK_SEPOLIA),
    },
  },
  {
    chain: robinhood,
    key: "ROBINHOOD",
    kind: "mainnet",
    icon: null,
    logChunk: 90_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ROBINHOOD),
      plates: null,
      waitlist: null,
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_ROBINHOOD),
    },
  },
  {
    chain: robinhoodTestnet,
    key: "ROBINHOOD_TESTNET",
    kind: "testnet",
    icon: null,
    logChunk: 60_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ROBINHOOD_TESTNET),
      plates: null,
      waitlist: null,
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_ROBINHOOD_TESTNET),
    },
  },
  {
    chain: anvil,
    key: "ANVIL",
    kind: "local",
    icon: null,
    logChunk: 9_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ANVIL),
      plates: envAddress(process.env.NEXT_PUBLIC_PLATES_ANVIL),
      waitlist: envAddress(process.env.NEXT_PUBLIC_WAITLIST_ANVIL),
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_ANVIL),
    },
  },
];

/// The viem definitions alone, which is what wagmi and every client builder want.
///
/// Derived from {@link NETWORKS} rather than listed again, so a network cannot be
/// switchable without a registry entry or the other way round. Asserted non-empty
/// because `createConfig` types `chains` as a non-empty tuple and TypeScript cannot
/// see that a `.map` of a non-empty literal is one.
export const CHAINS = NETWORKS.map((n) => n.chain) as unknown as readonly [
  Chain,
  ...Chain[],
];

/// Widened to `Chain` on purpose: anvil has no `blockExplorers`, and the union of
/// the literal types would make that key inaccessible at all.
export function chainById(id: number | undefined): Chain | undefined {
  if (id === undefined) return undefined;
  return (CHAINS as readonly Chain[]).find((c) => c.id === id);
}

/// The registry entry for a chain id, or undefined for one we do not serve.
export function networkFor(id: number | undefined): Network | undefined {
  if (id === undefined) return undefined;
  return NETWORKS.find((n) => n.chain.id === id);
}
