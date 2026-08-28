/**
 * Resolving an untrusted `metadataURI` into something fetchable.
 *
 * Split out of lib/metadata.ts, which is `"use client"`: every export of a client
 * module becomes a client reference, so calling one of these from a server route
 * throws rather than running. The share-card routes need exactly this logic on
 * the server — same gateway, same CID guard, same refusal to follow a scheme a
 * browser should not follow — and the alternative to a shared module is a second
 * copy of the rules that decide what is safe to fetch. Nothing about this is
 * React, so nothing about it needed to be in a client module in the first place.
 */

/**
 * A public gateway, used only for `ipfs://`. Content-addressed, so any gateway
 * *could* serve it — but it has to actually return the bytes and send CORS.
 * ipfs.io now 403s browser fetches and omits `Access-Control-Allow-Origin`,
 * which silently breaks every metadata + art load, so we resolve through
 * Pinata's gateway (where /api/upload pins, so the content is always there and
 * CORS is set) by default. Override with NEXT_PUBLIC_IPFS_GATEWAY to point at a
 * dedicated gateway — it must be the full `…/ipfs/` prefix.
 */
export const GATEWAY = (
  process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/"
).replace(/\/?$/, "/");

/**
 * A CID, roughly: base58 v0 or base32 v1.
 *
 * Checked because the local seed data uses placeholder URIs like
 * `ipfs://local/squid.json`, and sending those to a gateway means one doomed
 * request per row on every market load. A URI that cannot be a CID is treated as
 * "no art supplied", which is what it is.
 */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Gateways worth racing *from a server*, where CORS does not exist.
 *
 * The note above explains why `GATEWAY` is Pinata's: a browser can only use a
 * gateway that sends `Access-Control-Allow-Origin`, and of the fast ones none
 * reliably do. Nothing in that argument applies to a share card, which is
 * fetched by Node — and Pinata's *public* gateway is slow enough to be the
 * reason cards render without art at all. Measured 2026-08-28, three runs each
 * for the same 9.7 KB PNG:
 *
 *     ipfs.io          1109ms   848ms   106ms
 *     nftstorage.link   700ms   217ms   247ms
 *     dweb.link        1331ms   301ms   274ms
 *     pinata (public)  timeout 4587ms  5939ms
 *
 * So the server asks all of them at once and takes the first usable answer.
 * IPFS content is addressed by hash, so every gateway either returns the same
 * bytes or returns nothing — there is no "wrong" winner to guard against. That
 * also makes this a redundancy win rather than only a latency one: each of these
 * failed outright at least once while being benchmarked, and a race survives
 * that where a single gateway does not.
 *
 * `GATEWAY` stays first so an operator who configured a dedicated gateway gets
 * it — and being genuinely fast, it wins the race on merit.
 */
const RACE_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://dweb.link/ipfs/",
];

/** The `<cid>[/path]` an IPFS URI names, or null if it does not name one. */
function ipfsPath(raw: string): string | null {
  if (raw.startsWith("ipfs://")) {
    const path = raw.slice(7).replace(/^ipfs\//, "");
    return CID.test(path.split("/")[0]) ? path : null;
  }
  // A bare CID is common enough in the wild to be worth accepting.
  return CID.test(raw) ? raw : null;
}

/** The URI as something fetchable, or null if it is not something we follow. */
export function resolveUri(uri: string): string | null {
  const raw = uri.trim();
  if (!raw) return null;

  if (raw.startsWith("data:")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("ar://")) return `https://arweave.net/${raw.slice(5)}`;

  const path = ipfsPath(raw);
  return path === null ? null : GATEWAY + path;
}

/**
 * Every URL worth trying for a URI, in preference order — the server's
 * `resolveUri`.
 *
 * One element for anything that names a single location (`data:`, `http(s)`,
 * `ar://`), one per gateway for IPFS, and empty for a URI we do not follow. A
 * caller races them; see RACE_GATEWAYS for why that is worth doing and why it is
 * safe. Deliberately a separate export rather than a change to `resolveUri`:
 * client code wants one URL it can put in a `src`, and giving it a list it would
 * have to pick from is how the CORS rule above gets quietly broken later.
 */
export function resolveUriAll(uri: string): string[] {
  const raw = uri.trim();
  if (!raw) return [];

  const path = raw.startsWith("data:") || /^https?:\/\//i.test(raw) ? null : ipfsPath(raw);
  if (path === null) {
    const one = resolveUri(raw);
    return one ? [one] : [];
  }
  return [...new Set([GATEWAY, ...RACE_GATEWAYS].map((gateway) => gateway + path))];
}

/**
 * A link safe to drop into an `href`. Socials come from the same untrusted URI
 * as everything else, so only `http(s)` is allowed through — never a
 * `javascript:` or `data:` scheme that a click could execute.
 */
export function httpLink(value: string | null): string | null {
  if (!value) return null;
  const s = value.trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** Extension sniffing, kept safe against a URI that will not parse. */
export function looksLikeImage(url: string): boolean {
  try {
    return IMAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
