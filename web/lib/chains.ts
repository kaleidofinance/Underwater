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
/// dead site. Every client in the app reads these through {@link publicEndpoints},
/// which is this list with any configured override in front of it, so adding or
/// reordering an entry here is the whole change for the public ones. Both
/// endpoints on both chains verified live 2026-08-28: correct `eth_chainId`, they
/// answer a JSON-RPC batch array, and they send `access-control-allow-origin`, so
/// the browser can use them and not just the server.
///
/// These are shared endpoints with published addresses, which is fine for a testnet
/// and is a launch dependency on a mainnet: the load is every visitor's browser plus
/// this app's own server, and neither is something a free tier is sized for. Both
/// halves have an override — {@link publicEndpoints} for the browser and
/// `serverEndpoints` in lib/server-rpc.ts for the reads made on everyone's behalf.
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
  //
  // How much noisier, sampled again 2026-08-31 over three separate 10,000-block
  // windows: 133.8 / 130.5 / 148.1 ms, a 13% spread. Mainnet over the same three
  // windows held 100.9 / 101.5 / 101.1. So the "set by its sequencer, does not
  // drift" note above holds for mainnet and does not for this chain — which matters
  // only for how a window is *described*, since the value is used to turn a block
  // count back into hours and nothing here transacts on it.
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

/**
 * A mark its owner publishes as two files rather than one.
 *
 * Not a convenience for our palette — the distinction that matters is who decided.
 * Robinhood ships a black variant and a white variant of the chain mark and sets
 * `invertIconInDarkMode: true` in their explorer's own config, so serving each on
 * its intended ground is following the trademark's prescribed usage. Tinting a
 * single-file mark to suit a theme would be the thing components/ChainIcon.tsx
 * refuses, and this type is not a way to do it: both files are the owner's.
 */
export type ChainMark = {
  /** The variant for light ground. */
  light: string;
  /** The variant for dark ground. */
  dark: string;
  /**
   * width ÷ height, for artwork that is not square.
   *
   * Ink's disc fills a square box and needs none of this. Robinhood's feather has a
   * tight bounding box, so squaring it to the requested size would stretch it —
   * given a ratio, ChainIcon takes the size as the height and lets the width follow,
   * which also makes the two marks match by the height of their ink rather than by
   * the size of their boxes.
   */
  ratio?: number;
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
   *
   * A string is one file used on both themes. A {@link ChainMark} is a mark whose
   * owner publishes two, which is a fact about the trademark rather than a choice
   * available per network.
   */
  icon: string | ChainMark | null;
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
   * **Robinhood Testnet is the one entry that breaks that rule, on purpose**, and its
   * own comment in the table gives the arithmetic. The short version: density parity is
   * the right default only while something else bounds how far back a scan reaches. On
   * every other chain an indexer or an archive-backed `deployBlock` does that; on 46630
   * neither exists, so parity would mean a chunk count that grows with the chain and
   * passes any per-request budget within days.
   *
   * Not derived from {@link blockSeconds}, though it is sized against it: what an
   * endpoint will serve is a fact about the endpoint, and the two happen to line up
   * here rather than one following from the other.
   *
   * A width cannot be tuned against a matched-log cap, only kept clear of it, since how
   * many logs a range holds is not known before asking — and Ink has one of those too:
   * `rpc-gel-sepolia` refuses at twenty thousand results while `rpc-qnd-sepolia` beside
   * it serves eighty thousand, so which limit applies depends on which endpoint
   * `fallback` reached. The cap is therefore handled where the request is made rather
   * than here — `splitOnLogLimit` in lib/server-rpc.ts halves and retries a chunk
   * refused on count. Measured: our scans all filter by address and the caps count
   * matched logs, so this launchpad's whole history on Robinhood Testnet is six logs in
   * one request. The splitter is for the day that stops being true, not for today.
   */
  logChunk: bigint;
  deployments: Deployments;

  /**
   * Blocks our contracts first had code in, for chains that will not answer the
   * question, keyed by the address the answer belongs to.
   *
   * Normally nothing needs this. `deployBlock` in lib/chunks.ts finds the block by
   * probing `eth_getCode` backwards from the head, which is self-maintaining: it
   * cannot be left describing a contract that has since been replaced, because it
   * asks about the address it was given. Its own note rejects a `FROM_BLOCK`
   * variable for exactly that reason.
   *
   * The probe needs archive state, and Robinhood Testnet has none — it keeps roughly
   * twenty-eight minutes, so `eth_getCode` at a historical block answers `metadata is
   * not found` and the search cannot run at all. What it falls back to is
   * `MAX_LOOKBACK` blocks behind the head, and on that chain the fallback window
   * contains **no logs at all**: the launchpad is 1,076,857 blocks back and all six of
   * its logs sit at the far end, so a scan measured from the fallback reports an empty
   * history and cannot tell that from a chain nobody has traded on.
   *
   * **Keyed by address rather than by role, and that is the whole safety argument.**
   * The entries in {@link deployments} come from the environment, so a redeploy changes
   * them; a block written down beside the *role* would then describe the previous
   * contract, and a floor that is too late drops history silently. That is not
   * hypothetical here — `broadcast/Deploy.s.sol/46630/run-latest.json` points at a
   * second launchpad at block 110,459,312 which this app does not use, 351,729 blocks
   * after the one it does. Keyed by address, that mismatch cannot be introduced: an
   * address with no entry simply gets probed as usual, so being out of date degrades
   * to today's behaviour instead of to a wrong answer.
   *
   * Compared case-insensitively, so an entry can be pasted in the checksummed form the
   * broadcast receipts and `.env.local` both use. Too early is safe and merely slow;
   * too late is silent, so a value here comes from a deploy receipt rather than from
   * memory — the same rule `pointsFromBlock` states in lib/points.ts.
   */
  deployedAt?: Readonly<Record<string, bigint>>;
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
 * The declared deployment block for one address, or null to go and find it.
 *
 * Null is the answer for almost every call, and it means "probe" rather than "start at
 * genesis" — see {@link Network.deployedAt} for why the table is deliberately sparse
 * and keyed the way it is. Normalises both sides, so a checksummed entry matches a
 * lowercased address and the other way round.
 */
export function declaredDeployBlock(
  chainId: number | undefined,
  address: Address,
): bigint | null {
  const table = networkFor(chainId)?.deployedAt;
  if (!table) return null;
  const want = address.toLowerCase();
  for (const [at, block] of Object.entries(table)) {
    if (at.toLowerCase() === want) return block;
  }
  return null;
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
 * RPC endpoints out of one environment variable, best first.
 *
 * Comma-separated so a variable can carry a primary and a spare — two paid
 * endpoints fail over to each other before either falls back to a public one, which
 * is the shape anybody buying reliability actually wants.
 *
 * Silently drops anything that is not an `http(s)` URL rather than passing it to
 * `http()` to fail per request. The values this guards against are the ones a
 * hand-edited variable produces: a trailing comma, a quoted string, a websocket URL
 * pasted from a provider dashboard that lists both. A malformed entry is dropped and
 * the endpoints beside it still work, which is the behaviour that degrades rather
 * than the one that breaks.
 */
export function envRpcUrls(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\/[^\s/]+/i.test(part));
}

/**
 * The endpoints any client may use for a chain, in preference order.
 *
 * Overrides first, the registry's public endpoints behind them. Both halves are kept
 * rather than the override replacing them: `fallback` walks the list on error, so a
 * paid endpoint that is down or out of credit degrades to the public one instead of
 * taking the page with it, and the only cost of that is the position in the list.
 *
 * **This is the browser-safe half.** `NEXT_PUBLIC_*` is compiled into the bundle a
 * visitor downloads, so a URL here is published — it is for an endpoint that is safe
 * to publish, meaning one restricted by origin or referrer at the provider rather
 * than by the secrecy of its path. An endpoint whose URL *is* its credential belongs
 * in the server-only variable instead; see `serverEndpoints` in lib/server-rpc.ts,
 * which stacks that in front of this list for reads the server makes on everyone's
 * behalf.
 *
 * Written out one network at a time, for the reason {@link Network.key} gives: Next
 * inlines `process.env.NEXT_PUBLIC_X` only where the name is a literal, so a lookup
 * built from the key would be `undefined` in the browser — silently, which here would
 * mean quietly serving every visitor from the public endpoint the override exists to
 * get off.
 */
export function publicEndpoints(chain: Chain): readonly string[] {
  return [...publicOverride(chain.id), ...chain.rpcUrls.default.http];
}

function publicOverride(chainId: number): readonly string[] {
  switch (chainId) {
    case ink.id:
      return envRpcUrls(process.env.NEXT_PUBLIC_INK_RPC_URL);
    case inkSepolia.id:
      return envRpcUrls(process.env.NEXT_PUBLIC_INK_SEPOLIA_RPC_URL);
    case robinhood.id:
      return envRpcUrls(process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL);
    case robinhoodTestnet.id:
      return envRpcUrls(process.env.NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC_URL);
    default:
      // Anvil, which is already pointed at the machine the browser is running on.
      return [];
  }
}

/**
 * Every network this app serves, in the order the switcher lists them.
 *
 * **First is the default.** `chainFrom` in lib/server-rpc.ts answers for `CHAINS[0]`
 * when a request names no chain, and wagmi treats the head of the same list as the
 * chain to assume before a wallet has connected — so position zero is not a display
 * preference, it is what the app opens on for a visitor who has expressed no
 * preference and what every route returns without a `?chain=`.
 *
 * Robinhood Chain Testnet holds it, and that is a change of principle rather than of
 * order. This slot used to name the intended launch network — Ink Mainnet, then
 * Robinhood Mainnet — on the reasoning that the default says which chain is the
 * flagship. Neither is deployed, so what it actually said to a visitor who never
 * touched the switcher was "not deployed", on every route, including the market and
 * the swap box. A front door has to open. Until a mainnet launchpad exists, the
 * default names a network with contracts on it.
 *
 * So the head of this list is now a claim about what works and the rest of the order
 * is the old claim about what leads: the Robinhood pair still sits in front of the
 * Ink pair. The day a mainnet is deployed, `robinhood` moves back above its testnet
 * and nothing else here changes — moving this entry is how the front door moves.
 *
 * The pair itself is why the two families read differently: Robinhood lists testnet
 * then mainnet and Ink lists mainnet then testnet. The list groups by chain family
 * and always has — a network beside its own testnet, not beside every other mainnet —
 * and within a family the order is only an order. Only the head is a decision.
 *
 * **Which systems travel.** The launchpad, the DEX and uwPoints are chain-agnostic
 * and get an env var on every network. The plates collection and the waitlist do
 * not travel, and their entries are hard `null` rather than an unread variable:
 * `UnderwaterPlates` draws its art from Aave V3 health factors and there is no Aave
 * V3 on Robinhood, so the contract cannot function there at all, and the waitlist
 * is a single launch event tied to one chain rather than a system with an instance
 * per network. A null here is a statement that the deployment is impossible or
 * meaningless, not that it has not happened yet.
 *
 * Two consequences of this default worth stating rather than discovering. Plates and
 * the waterdrop are absent for a visitor who never switches, because 46630 is one of
 * the two networks that cannot carry them. And nothing indexes 46630 — its RPC keeps
 * about half an hour of state, so Ponder cannot backfill it — so the market, the
 * volume figures and uwPoints all answer from a live log walk on the default chain
 * rather than from Postgres: slower, and see the `logChunk` note below for the shape
 * of the walk. Both are the price of a default that has contracts on it.
 */
/**
 * Robinhood's chain mark, as its owner publishes it.
 *
 * Two files, both **byte-identical** to what `rh-testnet-web-assets` serves and
 * what the chain's testnet explorer declares as `NEXT_PUBLIC_NETWORK_ICON` and
 * `_ICON_DARK`. 779 bytes each, one `<path>`, a real vector — which is what makes
 * this the opposite case from Ink's, whose upstream "SVG" is a PNG in a wrapper and
 * had to be downscaled as a raster instead.
 *
 * The ratio is the artwork's own: viewBox `115.87 × 149.53`, a tight bounding box
 * rather than a padded square.
 *
 * These are also the same two files `brand/` uses for the co-brand cards, kept in
 * both places rather than shared: `brand/` is a folder of things people upload to X
 * and the app must not depend on it at build time.
 */
const ROBINHOOD_MARK: ChainMark = {
  light: "/chains/robinhood.svg",
  dark: "/chains/robinhood-white.svg",
  ratio: 115.87 / 149.53,
};

export const NETWORKS: readonly Network[] = [
  {
    chain: robinhoodTestnet,
    key: "ROBINHOOD_TESTNET",
    kind: "testnet",
    icon: ROBINHOOD_MARK,
    // Six hundred thousand, not the sixty thousand the density rule below would give
    // it, because on this chain that rule loses to arithmetic. Nothing indexes 46630 —
    // its RPC is not archive, so Ponder cannot backfill it — so every scan here is a
    // live walk from `deployedAt` to the head, and that distance is 1,081,941 blocks
    // and grows by about 590,000 a day at 6.8 blocks a second. At 60,000 that is
    // nineteen chunks today and ten more every day, doubled again by the two venues
    // each chunk reads; at 600,000 it is two, and one more roughly every other day.
    //
    // The density risk that width would normally buy is not actually taken, and this
    // is the part worth checking rather than assuming: a chunk refused on matched
    // count is halved by `splitOnLogLimit`, which is allowed sixteen leaves, so
    // 600,000 descends to 37,500-block requests — *finer* than the 60,000 this
    // replaces. The backstop is therefore strictly better than the width it stands in
    // for, and it fails loudly rather than under-reporting. Its one real caveat is
    // that the leaf budget is shared depth-first across the whole recursion, so a
    // lopsided history can spend it on the older half; that surfaces as a failed read,
    // which is the outcome to prefer.
    //
    // This does not scale forever and is not meant to: it buys weeks. The fix is an
    // indexer, and that is blocked on the archive state above, not on this number.
    logChunk: 600_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ROBINHOOD_TESTNET),
      plates: null,
      waitlist: null,
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_ROBINHOOD_TESTNET),
    },
    // The one chain that needs these, because it is the one whose endpoint cannot be
    // asked — see {@link Network.deployedAt}. Both blocks are the `blockNumber` on the
    // CREATE receipt in `broadcast/*.s.sol/46630/run-1788118822855.json` and
    // `run-1788118910379.json`; the launchpad's is independently corroborated by the
    // earliest log the endpoint returns for that address, which is a check worth doing
    // because `eth_getLogs` here is *not* pruned even though state is.
    deployedAt: {
      "0xeFe21b46e9603A574c7aBd3a88976f9B456D832B": 110_107_583n, // UnderwaterLaunchpad
      "0x57440671f8F67A56C4D56665553Bf7d8c2C73794": 110_108_223n, // UnderwaterPoints
    },
  },
  {
    chain: robinhood,
    key: "ROBINHOOD",
    kind: "mainnet",
    icon: ROBINHOOD_MARK,
    logChunk: 90_000n,
    deployments: {
      launchpad: envAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ROBINHOOD),
      plates: null,
      waitlist: null,
      points: envAddress(process.env.NEXT_PUBLIC_POINTS_ROBINHOOD),
    },
  },
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
