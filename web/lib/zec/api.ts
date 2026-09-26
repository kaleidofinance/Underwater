/**
 * Client for the Underwater ZEC API (zec/server). Public reads are plain
 * fetches; anything about the user's own account is signed with their key
 * (lib/zec/key.ts) in the exact format zec/server/auth.ts checks.
 */
import { loadOrCreateKey, sha256Hex, signBytes } from "./key";

export const ZEC_API = (process.env.NEXT_PUBLIC_ZEC_API ?? "http://localhost:8811").replace(/\/+$/, "");

// ─── Wire types (amounts are decimal strings) ─────────────────────────────

export interface ZecToken {
  id: string;
  name: string;
  symbol: string;
  metadataURI: string;
  creator: string;
  createdAt: number;
  graduated: boolean;
  progressBps: string;
  priceX18: string;
  price: number;
  marketCap: string;
  volume24h: string;
  lastTradeAt: number | null;
}

export interface ZecTokenDetail extends ZecToken {
  curve: { quoteReserve: string; tokenReserve: string; realQuoteRaised: string; tokensSold: string; graduationQuote: string };
  amm: { quote: string; token: string } | null;
  totalSupply: string;
  fees: { tradeFeeBps: string; graduationFeeBps: string; creationFee: string };
}

export interface ZecTrade {
  seq: number;
  ts: number;
  token: string;
  trader: string;
  side: "buy" | "sell";
  venue: "curve" | "amm";
  quote: string;
  tokens: string;
  fee: string;
  priceX18: string;
  price: number;
}

export interface ZecCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ZecQuote {
  venue: "curve" | "amm";
  out: string;
  fee: string;
  refund: string;
}

export interface ZecStats {
  tokens: number;
  graduated: number;
  volume24h: string;
  liabilities: string;
  protocolFees: string;
  loss: string;
}

export interface ZecReserves {
  ledger: string;
  wallet: string;
  drift: string;
  at: number;
}

export interface ZecMe {
  account: string;
  balance: string;
  withdrawable: string;
  immature: string;
  depositAddress: string | null;
  holdings: { token: string; symbol: string; amount: string }[];
  deposits: { id: string; amount: string; mature: boolean; reversed: boolean }[];
  withdrawals: { id: string; address: string; amount: string; fee: string; state: string; txid: string | null }[];
  withdrawalFee: string;
  minWithdrawal: string;
  withdrawalLimit: { limit: string; used: string; remaining: string };
}

export interface ZecSolvency {
  snapshot: { seq: number; head: string; root: string; liabilities: string; leaves: number };
  reserves: ZecReserves;
}

export interface ZecProof {
  snapshot: string;
  leaf: { id: string; amount: string };
  path: { hash: string; sum: string; side: "left" | "right" }[];
  root: { hash: string; sum: string };
}

export class ZecApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string };
    throw new ZecApiError(res.status, e.error ?? "Error", friendly(e.error, e.message ?? res.statusText));
  }
  return json as T;
}

export async function zecGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`${ZEC_API}${path}`, { cache: "no-store" }));
}

/** A request signed with this browser's account key. */
export async function zecSigned<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = await loadOrCreateKey();
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Date.now());
  const payload = `${method}\n${path}\n${ts}\n${await sha256Hex(new TextEncoder().encode(raw))}`;
  const res = await fetch(`${ZEC_API}${path}`, {
    method,
    cache: "no-store",
    headers: {
      ...(raw ? { "content-type": "application/json" } : {}),
      "x-uw-key": key.publicKey,
      "x-uw-ts": ts,
      "x-uw-sig": await signBytes(key, payload),
    },
    body: raw || undefined,
  });
  return parse<T>(res);
}

/** What the engine's error codes mean to a person. */
function friendly(code: string | undefined, fallback: string): string {
  switch (code) {
    case "InsufficientFunds":
      return "Not enough balance for that.";
    case "ImmatureFunds":
      return "Part of your balance is a deposit that isn't final yet (10 confirmations). You can trade it, but not withdraw it yet.";
    case "SlippageExceeded":
    case "InsufficientOutputAmount":
      return "The price moved past your slippage limit. Try again, or allow more slippage.";
    case "AlreadyGraduated":
      return "This token just graduated to the pool. Refresh and trade there.";
    case "InsufficientCreationFee":
      return "That's below the creation fee.";
    case "ZeroAmount":
    case "InsufficientInputAmount":
      return "That amount is too small to trade.";
    case "LimitExceeded":
      return `Over your daily withdrawal limit. ${fallback.replace(/^LimitExceeded: /, "")}`;
    case "Unauthorized":
      return "Your request couldn't be verified. Check your device clock, then try again.";
    default:
      return fallback;
  }
}

/** Live trades and launches. Returns a function that disconnects. */
export function zecStream(handlers: { trade?: (t: ZecTrade) => void; token?: (ev: unknown) => void }): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource(`${ZEC_API}/api/stream`);
  if (handlers.trade) es.addEventListener("trade", (e) => handlers.trade?.(JSON.parse((e as MessageEvent).data) as ZecTrade));
  if (handlers.token) es.addEventListener("token", (e) => handlers.token?.(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}
