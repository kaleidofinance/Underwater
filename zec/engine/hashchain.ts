/**
 * Tamper-evident command log.
 *
 * Each accepted command becomes a record whose hash covers its own content
 * and the previous record's hash, so rewriting any past entry changes every
 * hash after it. Publishing the head hash on-chain every N blocks (a Zcash
 * memo, docs/underwater-zec-v2.md §6) anchors the whole history: anyone
 * holding the log can check it against the anchored head.
 */
import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);

export interface ChainRecord {
  readonly seq: number;
  readonly prev: string;
  readonly hash: string;
  readonly body: unknown;
}

/**
 * Deterministic JSON: object keys sorted, bigints as decimal strings,
 * `undefined` members dropped. The same value always serializes to the same
 * bytes, which is what makes the hashes reproducible across machines.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return JSON.stringify(value.toString());
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
  }
}

function link(prev: string, seq: number, body: unknown): string {
  return createHash("sha256").update(prev).update(canonical({ seq, body })).digest("hex");
}

export class HashChain {
  #head = GENESIS;
  #records: ChainRecord[] = [];

  get head(): string {
    return this.#head;
  }

  get length(): number {
    return this.#records.length;
  }

  get records(): readonly ChainRecord[] {
    return this.#records;
  }

  append(body: unknown): ChainRecord {
    const seq = this.#records.length;
    const hash = link(this.#head, seq, body);
    const record: ChainRecord = { seq, prev: this.#head, hash, body };
    this.#records.push(record);
    this.#head = hash;
    return record;
  }

  /** Remove the newest record: undoes an append whose command then failed to persist. */
  pop(): ChainRecord | undefined {
    const record = this.#records.pop();
    if (record) this.#head = record.prev;
    return record;
  }

  /** Recompute every link from genesis; false if any record was altered, dropped or reordered. */
  static verify(records: readonly ChainRecord[]): boolean {
    let prev = GENESIS;
    for (const [i, r] of records.entries()) {
      if (r.seq !== i || r.prev !== prev || link(prev, r.seq, r.body) !== r.hash) return false;
      prev = r.hash;
    }
    return true;
  }
}
