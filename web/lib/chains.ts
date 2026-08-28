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
 * What that cost, on the one interface the public could reach: the gate's five
 * waitlist reads failed together, every field of `WaitlistState` fell back to its
 * zero, and a zero `closesAt` is `windowOf`'s `unconfigured` — which the live site
 * rendered as "The waterdrop has closed." over a registration window that was
 * open, with three days left on it. A read budget is not a performance concern
 * here. It is whether the page is telling the truth.
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
export const ink = defineChain({
  id: 57073,
  name: "Ink Mainnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-gel.inkonchain.com"] } },
  blockExplorers: {
    default: { name: "Inkscan", url: "https://explorer.inkonchain.com" },
  },
  contracts: MULTICALL,
});

export const inkSepolia = defineChain({
  id: 763373,
  name: "Ink Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-gel-sepolia.inkonchain.com"] } },
  blockExplorers: {
    default: {
      name: "Inkscan",
      url: "https://explorer-sepolia.inkonchain.com",
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
export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const CHAINS = [ink, inkSepolia, anvil] as const;

/// Widened to `Chain` on purpose: anvil has no `blockExplorers`, and the union of
/// the three literal types would make that key inaccessible at all.
export function chainById(id: number | undefined): Chain | undefined {
  if (id === undefined) return undefined;
  return (CHAINS as readonly Chain[]).find((c) => c.id === id);
}
