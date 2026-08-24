import { defineChain, type Chain } from "viem";

/// Defined here rather than imported from viem/chains so the explorer URLs and
/// RPCs match the ones the contracts were tested against, independent of which
/// viem version is installed. Verified live 2026-08-23.
export const ink = defineChain({
  id: 57073,
  name: "Ink",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-gel.inkonchain.com"] } },
  blockExplorers: {
    default: { name: "Inkscan", url: "https://explorer.inkonchain.com" },
  },
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
  testnet: true,
});

/// Local anvil, for developing against `npm run localchain` before anything is
/// deployed to a real network.
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
