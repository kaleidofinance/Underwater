import { defineChain, type Chain } from "viem";

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
 * Verified live on both Ink chains 2026-08-28: the same 3808-byte deployment on
 * each. No `blockCreated`, which viem only needs to read at a historical block;
 * every read in this app is at `latest`.
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

/// Robinhood Chain, and its testnet. A second home for the launchpad, not a
/// replacement for the first. Verified live by direct RPC call 2026-08-31.
///
/// **Arbitrum Nitro, not OP Stack**, which is why nothing above is copied down
/// here by habit. There is no WETH predeploy — `0x42…0006` is empty on both, and
/// the WETHs the DEX uses are ordinary deployments recorded in `script/Weth.sol`.
/// Multicall3 *is* at the canonical address on both, confirmed by `eth_getCode`
/// rather than assumed: the same 7,616-hex-char deployment on each, which is what
/// earns them `MULTICALL` at all. The note on MULTICALL3 is about what claiming a
/// missing one costs.
///
/// One RPC each, unlike the two Ink chains, and it is the whole known public list
/// rather than a preference: `rpc.chain.robinhood.com` — the host the public
/// chainlists carry — does not resolve, and each network has exactly one endpoint
/// that answers. `fallback` over a single entry is still what providers.tsx
/// builds, so viem retries it rather than moving on; there is nowhere to move to.
///
/// Their explorers are both Blockscout, and named for it because that is what the
/// switcher shows. Mainnet's sits behind a Cloudflare interstitial a CLI cannot
/// pass, so verifying a contract there may mean the web form; the testnet's API
/// answers plain HTTP and `forge --verify` works.
///
/// `name` is the string each chain's own explorer publishes as
/// `NEXT_PUBLIC_NETWORK_NAME` — "Robinhood Chain" and "Robinhood Chain Testnet",
/// read out of their Blockscout configs rather than shortened to taste, for the
/// same reason the Ink pair is named symmetrically above.
///
/// **`blockTime` here is a measured rate, not a fixed parameter, and that is the
/// difference from the two Ink chains.** Nitro produces a block when there is
/// something to put in it, so there is no interval to declare. Sampled over three
/// separate 10,000-block windows on 2026-08-31: mainnet held 100.9 / 101.5 /
/// 101.1 ms, so 100 is its evident target and the 1% of slack is invisible in an
/// hours label; testnet ran 133.8 / 130.5 / 148.1 ms, a 13% spread, and 135 is the
/// middle of it rather than a promise. The only consumer is the day window in
/// app/api/volume/route.ts turning blocks back into hours, where being a tenth of
/// an hour out on "last 24 hours" is not a number anybody can see.
///
/// What that speed *does* change is every block count in the log scanners, and
/// nothing in lib/chunks.ts has been retuned for it: a day is ~864,000 blocks here
/// against ~86,400 on Ink, so `CHUNK` of 9,000 buys a tenth as much history per
/// request and `MAX_LOOKBACK` of 1,000,000 reaches back about a day rather than
/// eleven. Nothing scans these chains until a launchpad address is configured for
/// one — `candidates()` in lib/og-data.ts and every `*For()` below filter on
/// exactly that — so this is a thing to fix before deploying here, not a thing
/// that is currently wrong.
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  blockTime: 100,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: MULTICALL,
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  blockTime: 135,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
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
/// No `multicall3`, unlike the two above. Recent anvil predeploys one at the
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

/// Mainnets first, then their testnets, then local — the order the switcher lists
/// them in, and `CHAINS[0]` is the default a request without a chain parameter gets
/// (see `chainFromRequest` in lib/server-rpc.ts), so Ink Mainnet staying first is
/// load-bearing rather than alphabetical.
export const CHAINS = [
  ink,
  inkSepolia,
  robinhood,
  robinhoodTestnet,
  anvil,
] as const;

/// Widened to `Chain` on purpose: anvil has no `blockExplorers`, and the union of
/// the five literal types would make that key inaccessible at all.
export function chainById(id: number | undefined): Chain | undefined {
  if (id === undefined) return undefined;
  return (CHAINS as readonly Chain[]).find((c) => c.id === id);
}
