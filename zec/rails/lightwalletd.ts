/**
 * Minimal lightwalletd client: gRPC over HTTP/2 with hand-rolled protobuf, so
 * it needs nothing beyond Node itself.
 *
 * It covers the half of `ZcashWallet` that needs no keys: the chain tip,
 * looking a transaction up, and broadcasting a raw one. The other half
 * (trial-decrypting blocks with the treasury's viewing key, and building and
 * proving spends) needs librustzcash, which is step 2b.
 *
 * Service: cash.z.wallet.sdk.rpc.CompactTxStreamer (lightwalletd service.proto).
 */
import { connect, type ClientHttp2Session } from "node:http2";

/**
 * Public testnet lightwalletd servers. ECC's own testnet server
 * (lightwalletd.testnet.electriccoin.co) was refusing TLS handshakes when
 * checked on 2026-09-26, so it's left out.
 */
export const TESTNET_SERVERS = ["https://testnet.zec.rocks:443"];

const SERVICE = "/cash.z.wallet.sdk.rpc.CompactTxStreamer/";

export interface LightdInfo {
  readonly version: string;
  readonly vendor: string;
  readonly chainName: string;
  readonly saplingActivationHeight: number;
  readonly consensusBranchId: string;
  readonly blockHeight: number;
  readonly estimatedHeight: number;
}

export interface CompactBlockSummary {
  readonly height: number;
  /** Block hash, display order (as explorers show it). */
  readonly hash: string;
  readonly time: number;
  /** Transaction hashes exactly as the server sends them: what `getTransaction` expects back. */
  readonly txHashes: readonly Uint8Array[];
}

export class Lightwalletd {
  readonly url: string;
  #session: ClientHttp2Session | null = null;

  constructor(url: string = TESTNET_SERVERS[0] ?? "") {
    this.url = url;
  }

  async info(): Promise<LightdInfo> {
    const f = decode(await this.#unary("GetLightdInfo", new Uint8Array()));
    return {
      version: str(f, 1),
      vendor: str(f, 2),
      chainName: str(f, 4),
      saplingActivationHeight: num(f, 5),
      consensusBranchId: str(f, 6),
      blockHeight: num(f, 7),
      estimatedHeight: num(f, 12),
    };
  }

  /** Current best-chain tip. */
  async latestBlock(): Promise<{ height: number; hash: string }> {
    const f = decode(await this.#unary("GetLatestBlock", new Uint8Array()));
    return { height: num(f, 1), hash: toHex(reverse(bytes(f, 2))) };
  }

  async block(height: number): Promise<CompactBlockSummary> {
    const f = decode(await this.#unary("GetBlock", varintField(1, BigInt(height))));
    const txHashes = (f.get(7) ?? []).map((tx) => bytes(decode(tx as Uint8Array), 2));
    return { height: num(f, 2), hash: toHex(reverse(bytes(f, 3))), time: num(f, 5), txHashes };
  }

  /** Look a transaction up by hash (wire order). Null if the server doesn't know it. */
  async transaction(hash: Uint8Array): Promise<{ height: number; size: number } | null> {
    try {
      const f = decode(await this.#unary("GetTransaction", field(3, hash)));
      return { height: num(f, 2), size: bytes(f, 1).length };
    } catch (err) {
      if (err instanceof GrpcError && (err.code === 5 || /not found|No information/i.test(err.message))) return null;
      throw err;
    }
  }

  /** Broadcast a raw transaction. Throws with the node's reason if it's rejected. */
  async send(raw: Uint8Array): Promise<void> {
    const f = decode(await this.#unary("SendTransaction", field(1, raw)));
    const code = num(f, 1);
    if (code !== 0) throw new Error(`rejected (${code}): ${str(f, 2)}`);
  }

  close(): void {
    this.#session?.close();
    this.#session = null;
  }

  #unary(method: string, message: Uint8Array, timeoutMs = 20_000): Promise<Uint8Array> {
    if (!this.#session || this.#session.closed || this.#session.destroyed) {
      this.#session = connect(this.url);
      this.#session.on("error", () => {
        this.#session = null;
      });
    }
    const session = this.#session;
    return new Promise((resolve, reject) => {
      const req = session.request({
        ":method": "POST",
        ":path": SERVICE + method,
        "content-type": "application/grpc",
        te: "trailers",
      });
      const timer = setTimeout(() => req.close(), timeoutMs);
      const chunks: Buffer[] = [];
      let status = "0";
      let statusMessage = "";
      req.on("response", (headers) => {
        if (headers["grpc-status"] !== undefined) status = String(headers["grpc-status"]);
      });
      req.on("trailers", (trailers) => {
        status = String(trailers["grpc-status"] ?? status);
        statusMessage = decodeURIComponent(String(trailers["grpc-message"] ?? ""));
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on("close", () => {
        clearTimeout(timer);
        if (status !== "0") return reject(new GrpcError(Number(status), statusMessage || `grpc status ${status}`));
        const body = Buffer.concat(chunks);
        if (body.length < 5) return reject(new GrpcError(-1, `${method}: empty or timed-out response`));
        const length = body.readUInt32BE(1);
        resolve(new Uint8Array(body.subarray(5, 5 + length)));
      });
      const frame = Buffer.alloc(5 + message.length);
      frame.writeUInt32BE(message.length, 1);
      frame.set(message, 5);
      req.end(frame);
    });
  }
}

export class GrpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ─── Minimal protobuf ───────────────────────────────────────────────────────

type Fields = Map<number, (bigint | Uint8Array)[]>;

function varint(v: bigint): Uint8Array {
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Uint8Array.from(out);
}

/** A varint field (wire type 0). */
function varintField(no: number, value: bigint): Uint8Array {
  const tag = varint(BigInt(no << 3));
  const v = varint(value);
  const out = new Uint8Array(tag.length + v.length);
  out.set(tag, 0);
  out.set(v, tag.length);
  return out;
}

/** A length-delimited field (wire type 2). */
function field(no: number, value: Uint8Array): Uint8Array {
  const tag = varint(BigInt((no << 3) | 2));
  const len = varint(BigInt(value.length));
  const out = new Uint8Array(tag.length + len.length + value.length);
  out.set(tag, 0);
  out.set(len, tag.length);
  out.set(value, tag.length + len.length);
  return out;
}

export function decode(buf: Uint8Array): Fields {
  const fields: Fields = new Map();
  let i = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++];
      if (b === undefined) throw new Error("truncated varint");
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(readVarint());
    const no = tag >> 3;
    let value: bigint | Uint8Array;
    switch (tag & 7) {
      case 0:
        value = readVarint();
        break;
      case 2: {
        const len = Number(readVarint());
        value = buf.subarray(i, i + len);
        i += len;
        break;
      }
      case 1:
        i += 8;
        continue;
      case 5:
        i += 4;
        continue;
      default:
        throw new Error(`unsupported wire type ${tag & 7}`);
    }
    const list = fields.get(no) ?? [];
    list.push(value);
    fields.set(no, list);
  }
  return fields;
}

const first = (f: Fields, no: number) => f.get(no)?.[0];
const num = (f: Fields, no: number): number => Number((first(f, no) as bigint | undefined) ?? 0n);
const bytes = (f: Fields, no: number): Uint8Array => (first(f, no) as Uint8Array | undefined) ?? new Uint8Array();
const str = (f: Fields, no: number): string => new TextDecoder().decode(bytes(f, no));
const reverse = (b: Uint8Array): Uint8Array => Uint8Array.from(b).reverse();
export const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
