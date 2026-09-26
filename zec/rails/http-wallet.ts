/**
 * `ZcashWallet` over the treasury wallet service (zec/wallet-service): the
 * real implementation behind the rails, next to sim.ts for tests.
 *
 * The service holds the keys. This side only ever sends amounts and
 * addresses and gets back notes and transaction ids, with every amount a
 * decimal string on the wire.
 */
import type { Balances, IncomingNote, Output, PreparedTx, ReserveInfo, TxStatus, ZcashWallet } from "./wallet.ts";

export interface HttpWalletOptions {
  /** e.g. https://zec-wallet-production.up.railway.app */
  readonly url: string;
  readonly token: string;
  /** Building a withdrawal proves Halo 2 circuits, which takes seconds; give it room. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export class HttpWallet implements ZcashWallet {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpWalletOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async tip(): Promise<number> {
    return (await this.#call<{ height: number }>("GET", "/tip")).height;
  }

  async addressAt(index: number): Promise<string> {
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) throw new RangeError(`bad index ${index}`);
    return (await this.#call<{ address: string }>("GET", `/address/${index}`)).address;
  }

  async incoming(fromHeight: number): Promise<IncomingNote[]> {
    const notes = await this.#call<Array<{ id: string; txid: string; addressIndex: number; amount: string; height: number }>>(
      "GET",
      `/incoming?from=${Math.max(0, Math.floor(fromHeight))}`,
    );
    return notes.map((n) => ({ ...n, amount: BigInt(n.amount) }));
  }

  async validateAddress(address: string): Promise<boolean> {
    return (await this.#call<{ valid: boolean }>("POST", "/validate", { address })).valid;
  }

  async spendable(): Promise<bigint> {
    return BigInt((await this.#call<{ zats: string }>("GET", "/spendable")).zats);
  }

  async balances(): Promise<Balances> {
    type Wire = { total: string; spendable: string };
    const r = await this.#call<{ treasury: Wire; reserve: Wire }>("GET", "/balances");
    const totals = (a: Wire) => ({ total: BigInt(a.total), spendable: BigInt(a.spendable) });
    return { treasury: totals(r.treasury), reserve: totals(r.reserve) };
  }

  async reserveInfo(): Promise<ReserveInfo> {
    return this.#call<ReserveInfo>("GET", "/reserve");
  }

  async sweep(): Promise<PreparedTx | null> {
    const r = await this.#call<{ txid: string | null; fee?: string }>("POST", "/sweep", {});
    return r.txid === null ? null : { txid: r.txid, fee: BigInt(r.fee ?? "0") };
  }

  async anchor(memo: string): Promise<PreparedTx> {
    const r = await this.#call<{ txid: string; fee: string }>("POST", "/anchor", { memo });
    return { txid: r.txid, fee: BigInt(r.fee) };
  }

  async prepare(outputs: readonly Output[]): Promise<PreparedTx> {
    const r = await this.#call<{ txid: string; fee: string }>("POST", "/prepare", {
      outputs: outputs.map((o) => ({ address: o.address, amount: o.amount.toString() })),
    });
    return { txid: r.txid, fee: BigInt(r.fee) };
  }

  async broadcast(txid: string): Promise<void> {
    await this.#call("POST", "/broadcast", { txid });
  }

  async status(txid: string): Promise<TxStatus> {
    return this.#call<TxStatus>("GET", `/status/${encodeURIComponent(txid)}`);
  }

  async #call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(this.#url + path, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const reason = (json as { error?: string } | undefined)?.error ?? (text.slice(0, 200) || res.statusText);
      throw new Error(`wallet ${method} ${path}: ${res.status} ${reason}`);
    }
    return json as T;
  }
}
