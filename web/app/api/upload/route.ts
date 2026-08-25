import { NextResponse } from "next/server";

/**
 * Pins a token's logo, banner, and metadata document to IPFS via Pinata, and
 * hands back the `ipfs://` URI the launchpad stores on chain forever.
 *
 * Why a server route and not a client call: pinning needs the Pinata API key,
 * and that key must never reach the browser bundle. It lives in PINATA_JWT in
 * web/.env.local (server-only — no NEXT_PUBLIC prefix), so only this route can
 * spend the account. The `create` transaction is still signed by the user's
 * wallet; the only thing that happens here is pinning.
 *
 * Pinata is a plain HTTPS API — no SDK, nothing Node-specific beyond
 * FormData/Blob — but we keep the Node runtime for headroom on larger uploads.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PIN_FILE = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const PIN_JSON = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

// Guardrails: the browser already checks these, but a route that trusts the
// client is a route that pins whatever anyone POSTs to it.
const MAX_LOGO = 5 * 1024 * 1024;
const MAX_BANNER = 10 * 1024 * 1024;
const MAX_FIELD = 2_000;

class NotConfigured extends Error {}
class BadInput extends Error {}
class PinFailed extends Error {}

/** The server-only Pinata key, or NotConfigured if the operator hasn't set it. */
function apiKey(): string {
  const t = process.env.PINATA_JWT;
  if (!t) throw new NotConfigured();
  return t;
}

/** Validate an image and pin it to IPFS, returning its CID. */
async function pinFile(
  file: File,
  max: number,
  label: string,
  token: string,
): Promise<string> {
  if (file.size > max) {
    throw new BadInput(`${label} is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  }
  if (!file.type.startsWith("image/")) {
    throw new BadInput(`${label} must be an image.`);
  }
  const body = new FormData();
  // Send the file part *alone*. Pinata's current backend rejects a
  // pinFileToIPFS multipart that also carries `pinataOptions`/`pinataMetadata`
  // text fields — it misroutes to their v3 parser and 400s with a bogus
  // "File size must be greater than 0". A bare file pins fine and is named after
  // its filename. We also copy the bytes into a fresh Blob rather than
  // re-appending the request's own File, which that same parser reads as empty.
  body.append("file", new Blob([await file.arrayBuffer()], { type: file.type }), file.name || label);
  const res = await fetch(PIN_FILE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  return readCid(res, label);
}

/** Pin a JSON document to IPFS, returning its CID. */
async function pinJson(doc: unknown, name: string, token: string): Promise<string> {
  const res = await fetch(PIN_JSON, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: doc,
      pinataMetadata: { name },
      pinataOptions: { cidVersion: 1 },
    }),
  });
  return readCid(res, "metadata");
}

/** Pull the CID out of a Pinata response, turning any failure into PinFailed. */
async function readCid(res: Response, what: string): Promise<string> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[upload] pinning ${what} failed: ${res.status} ${detail.slice(0, 500)}`);
    // 401/403 almost always means a missing or wrong PINATA_JWT — the one thing
    // the operator can actually fix, so name it instead of a generic failure.
    if (res.status === 401 || res.status === 403) {
      throw new PinFailed("IPFS upload was rejected — check PINATA_JWT in web/.env.local.");
    }
    throw new PinFailed("Could not pin to IPFS. Try again.");
  }
  const json = (await res.json().catch(() => null)) as { IpfsHash?: string } | null;
  if (!json?.IpfsHash) throw new PinFailed("Could not pin to IPFS. Try again.");
  return json.IpfsHash;
}

/** A trimmed, length-capped string field, or undefined if empty. */
function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, MAX_FIELD);
  return t.length ? t : undefined;
}

/** Give the browser a URL, not a bare handle, and refuse anything unsafe. */
function link(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w.@/-]+$/.test(v)) return base + v.replace(/^@/, "");
  return undefined;
}

function website(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v)) return `https://${v}`;
  return undefined;
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const logo = form.get("logo");
  if (!(logo instanceof File) || logo.size === 0) {
    return NextResponse.json({ error: "A token logo is required." }, { status: 400 });
  }
  const bannerFile = form.get("banner");
  const hasBanner = bannerFile instanceof File && bannerFile.size > 0;

  const name = field(form, "name");
  const symbol = field(form, "symbol");
  if (!name || !symbol) {
    return NextResponse.json({ error: "Name and symbol are required." }, { status: 400 });
  }

  try {
    const token = apiKey();

    const logoCid = await pinFile(logo, MAX_LOGO, "Logo", token);
    let bannerCid: string | null = null;
    if (hasBanner) {
      bannerCid = await pinFile(bannerFile as File, MAX_BANNER, "Banner", token);
    }

    // The document the token points at. Flat keys are what lib/metadata.ts
    // reads; `external_url` is the widely-recognised name for a project site,
    // kept alongside `website` so other explorers pick it up too.
    const doc: Record<string, string> = {
      name,
      symbol,
      image: `ipfs://${logoCid}`,
    };
    if (bannerCid) doc.banner = `ipfs://${bannerCid}`;
    const description = field(form, "description");
    if (description) doc.description = description;
    const site = website(field(form, "website"));
    if (site) {
      doc.website = site;
      doc.external_url = site;
    }
    const twitter = link(field(form, "twitter"), "https://x.com/");
    if (twitter) doc.twitter = twitter;
    const telegram = link(field(form, "telegram"), "https://t.me/");
    if (telegram) doc.telegram = telegram;
    const discord = link(field(form, "discord"), "https://discord.gg/");
    if (discord) doc.discord = discord;

    const jsonCid = await pinJson(doc, `${symbol} metadata`, token);

    return NextResponse.json({ uri: `ipfs://${jsonCid}` });
  } catch (err) {
    if (err instanceof NotConfigured) {
      return NextResponse.json(
        {
          error:
            "IPFS uploads are not configured on the server. Set PINATA_JWT in web/.env.local.",
        },
        { status: 501 },
      );
    }
    if (err instanceof BadInput) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof PinFailed) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[upload] pin failed:", err);
    return NextResponse.json({ error: "Could not pin to IPFS. Try again." }, { status: 502 });
  }
}
