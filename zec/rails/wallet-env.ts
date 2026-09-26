import { readFileSync } from "node:fs";
import { join } from "node:path";

/** WALLET_URL and WALLET_API_TOKEN from the environment, else `<root>/.env.wallet` (gitignored). */
export function readWalletEnv(root: string): { url: string; token: string } {
  const file: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(root, ".env.wallet"), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m?.[1] && m[2] !== undefined) file[m[1]] = m[2];
    }
  } catch {
    /* no file: the environment has to have them */
  }
  const url = process.env.WALLET_URL ?? file.WALLET_URL;
  const token = process.env.WALLET_API_TOKEN ?? file.WALLET_API_TOKEN;
  if (!url || !token) throw new Error("set WALLET_URL and WALLET_API_TOKEN (environment or zec/.env.wallet)");
  return { url, token };
}
