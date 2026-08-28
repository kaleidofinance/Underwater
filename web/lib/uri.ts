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

/** The URI as something fetchable, or null if it is not something we follow. */
export function resolveUri(uri: string): string | null {
  const raw = uri.trim();
  if (!raw) return null;

  if (raw.startsWith("data:")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;

  if (raw.startsWith("ipfs://")) {
    const path = raw.slice(7).replace(/^ipfs\//, "");
    const cid = path.split("/")[0];
    return CID.test(cid) ? GATEWAY + path : null;
  }
  if (raw.startsWith("ar://")) return `https://arweave.net/${raw.slice(5)}`;

  // A bare CID is common enough in the wild to be worth accepting.
  if (CID.test(raw)) return GATEWAY + raw;

  return null;
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
