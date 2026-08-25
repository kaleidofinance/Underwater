/**
 * Client side of the launch upload: gather the logo, banner, and text fields,
 * hand them to the server route that pins them (see app/api/upload/route.ts),
 * and get back the single `ipfs://` URI the launchpad stores on chain.
 *
 * The browser never sees the storage credential — it only ever talks to our
 * own route, which does the pinning and returns a URI.
 */

export type TokenLaunchMeta = {
  name: string;
  symbol: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  logo: File;
  banner?: File | null;
};

export async function uploadTokenMetadata(m: TokenLaunchMeta): Promise<string> {
  const form = new FormData();
  form.set("name", m.name);
  form.set("symbol", m.symbol);
  if (m.description) form.set("description", m.description);
  if (m.website) form.set("website", m.website);
  if (m.twitter) form.set("twitter", m.twitter);
  if (m.telegram) form.set("telegram", m.telegram);
  if (m.discord) form.set("discord", m.discord);
  form.set("logo", m.logo);
  if (m.banner) form.set("banner", m.banner);

  const res = await fetch("/api/upload", { method: "POST", body: form });
  const json = (await res.json().catch(() => null)) as
    | { uri?: string; error?: string }
    | null;

  if (!res.ok) {
    throw new Error(json?.error ?? `Upload failed (${res.status}).`);
  }
  if (!json?.uri) {
    throw new Error("Upload succeeded but returned no URI.");
  }
  return json.uri;
}
