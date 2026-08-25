"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Token art, from whatever the creator put in `metadataURI`.
 *
 * The launchpad stores that string and never looks at it, which is the right
 * design on chain and leaves the resolving to be done here: an `ipfs://` URI has
 * to go through a gateway, a `data:` URI is already the thing, and the field may
 * point at either an image or a metadata document that names one.
 *
 * Nothing about this is trusted. The URI comes from whoever launched the token,
 * so only schemes that a browser can safely fetch are followed at all, the
 * response is capped, and a URI that resolves to nothing simply falls back to a
 * generated mark rather than leaving a broken image in the list.
 */

/** A public gateway, used only for `ipfs://`. Content-addressed, so any will do. */
const GATEWAY = "https://ipfs.io/ipfs/";

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

/** Ceiling on a metadata document, so a hostile URI cannot hand us a gigabyte. */
const MAX_JSON = 256_000;

export type TokenMeta = {
  /** A URL an `<img>` can use, if one was found. */
  image: string | null;
  name: string | null;
  description: string | null;
  /** A wide header image, resolved like `image`. */
  banner: string | null;
  /** Links, kept only when they are http(s) — never rendered raw otherwise. */
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
};

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
 * Resolve a token's metadata once per URI, for the session.
 *
 * `staleTime: Infinity` because content-addressed art does not change, and a
 * market page mounting forty rows must not turn into forty refetches every time
 * the listings poll comes back.
 */
export function useTokenMeta(uri: string | undefined) {
  const url = useMemo(() => resolveUri(uri ?? ""), [uri]);

  const { data, isLoading } = useQuery({
    queryKey: ["token-meta", url],
    enabled: !!url,
    staleTime: Infinity,
    gcTime: Infinity,
    // One shot: a gateway that 404s or a URI that was never art will not become
    // one on a retry, and this runs once per row.
    retry: false,
    queryFn: () => fetchMeta(url as string),
  });

  return { url, meta: data ?? null, isLoading: !!url && isLoading };
}

async function fetchMeta(url: string): Promise<TokenMeta> {
  const none: TokenMeta = {
    image: null,
    name: null,
    description: null,
    banner: null,
    website: null,
    twitter: null,
    telegram: null,
    discord: null,
  };

  // Art rather than a document needs no request at all — the `<img>` will make
  // the only one that matters.
  if (url.startsWith("data:image/")) return { ...none, image: url };
  if (looksLikeImage(url)) return { ...none, image: url };

  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json,image/*;q=0.8" },
  });
  if (!res.ok) return none;

  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("image/")) return { ...none, image: url };

  const text = (await res.text()).slice(0, MAX_JSON);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return none;
  }

  const str = (key: string) =>
    typeof json[key] === "string" ? (json[key] as string) : null;
  const image = str("image") ?? str("image_url") ?? str("imageUrl");
  const banner = str("banner") ?? str("banner_url") ?? str("bannerUrl");
  const website = str("website") ?? str("external_url") ?? str("externalUrl");

  return {
    image: image ? resolveUri(image) : null,
    name: str("name"),
    description: str("description"),
    banner: banner ? resolveUri(banner) : null,
    website: httpLink(website),
    twitter: httpLink(str("twitter") ?? str("x")),
    telegram: httpLink(str("telegram")),
    discord: httpLink(str("discord")),
  };
}

/**
 * A link safe to drop into an `href`. Socials come from the same untrusted URI
 * as everything else, so only `http(s)` is allowed through — never a
 * `javascript:` or `data:` scheme that a click could execute.
 */
function httpLink(value: string | null): string | null {
  if (!value) return null;
  const s = value.trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** Extension sniffing, kept safe against a URI that will not parse. */
function looksLikeImage(url: string): boolean {
  try {
    return IMAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
