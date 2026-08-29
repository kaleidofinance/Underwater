/**
 * Sending chain numbers over JSON.
 *
 * Every quantity in this app is a `bigint` — reserves, prices at 1e18, market
 * caps, block numbers — and `JSON.stringify` throws on one rather than guessing a
 * representation. So the moment any of this moves from a route handler to the
 * browser it needs a convention, and it needs to be *one* convention: a decimal
 * string, converted at the boundary and nowhere else.
 *
 * Not `Number`. A price at 1e18 exceeds `Number.MAX_SAFE_INTEGER` by nine orders
 * of magnitude, so a JSON number would silently round the least significant
 * digits of every figure on the site — and the rounding would land in the digits
 * that distinguish one trade from another.
 *
 * The two directions are deliberately not symmetrical, because they are not
 * equally safe:
 *
 *  - **Encoding is generic.** A `bigint` identifies itself at runtime, so a deep
 *    walk that stringifies every one it meets cannot mistake anything else for a
 *    number. {@link encodeWire} is total and needs no schema.
 *  - **Decoding is explicit.** A string on the wire may be a quantity or it may be
 *    a token's name, symbol or `metadataURI` — all of which are attacker-supplied
 *    strings that could be spelled like an integer. Nothing at runtime can tell
 *    them apart, so each payload names its own numeric fields via {@link big}
 *    rather than a generic reviver guessing from shape.
 *
 * {@link Wire} is what keeps the two honest: it derives the wire type from the
 * domain type, so a route whose encoder and decoder disagree fails to compile
 * instead of shipping a string where the UI does arithmetic.
 */

/**
 * A payload's shape on the wire: every `bigint` becomes a decimal string, and
 * everything else is left alone.
 *
 * Distributes over unions, which is the case that matters — `Trade.raised` is
 * `bigint | null` and has to arrive as `string | null`, not as a string that is
 * sometimes the four characters "null".
 *
 * Only plain data. Anything with methods or a prototype worth keeping (a `Date`,
 * a `Map`) survives the type but not the round trip, and nothing in this app
 * sends one — timestamps are already numbers because that is what the chain gives.
 */
export type Wire<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * A payload ready for `JSON.stringify`.
 *
 * Rebuilds rather than mutating: the values handed to this are React Query cache
 * entries and viem decode results on the server, and a walk that wrote through
 * them would be editing something another request is still reading.
 */
export function encodeWire<T>(value: T): Wire<T> {
  return walk(value) as Wire<T>;
}

function walk(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(walk);
  // `null` is typeof "object", and Object.entries(null) throws.
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = walk(v);
    return out;
  }
  return value;
}

/** A malformed payload. Thrown, never swallowed — see {@link big}. */
export class WireError extends Error {}

/**
 * One decimal string back to a `bigint`.
 *
 * **Throws** on anything else, and that is the whole point of it. The tempting
 * version returns `0n` for a missing or unparseable field, and this codebase has
 * already paid for that shape once: every field of `WaitlistState` falls back to
 * its zero, a zero `closesAt` is `windowOf`'s `unconfigured`, and the live gate
 * told the public "The waterdrop has closed." over a window that was open with
 * three days left on it (see the note on `MULTICALL3` in lib/chains.ts). A zero is
 * indistinguishable from a real zero; an exception is not.
 *
 * So a decoder built on this fails its whole query, React Query reports the error,
 * and the hook's `isLoading`/`error` path renders — rather than the page stating a
 * confident wrong number. Refusing to parse is a worse experience and a far better
 * failure.
 */
export function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new WireError(
    `expected a decimal string, got ${value === null ? "null" : typeof value}`,
  );
}

/** Same, for a field the payload is allowed to omit or send as null. */
export function bigOrNull(value: unknown): bigint | null {
  return value === null || value === undefined ? null : big(value);
}

/**
 * Fetch JSON from one of our own routes, with the failure modes named.
 *
 * A non-2xx is an error rather than a value: these routes answer 502 when the
 * chain would not talk to them, and a hook that treated that as data would render
 * whatever `decode` made of an error envelope. React Query's retry and the hook's
 * own fallback both need this to reject.
 */
export async function getJson<T>(
  url: string,
  decode: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new WireError(`${url}: ${res.status}`);
  return decode(await res.json());
}
