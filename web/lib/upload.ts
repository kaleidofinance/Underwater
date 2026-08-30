/**
 * Client side of the launch upload: gather the logo, banner, and text fields,
 * hand them to the server route that pins them (see app/api/upload/route.ts),
 * and get back the single `ipfs://` URI the launchpad stores on chain.
 *
 * The browser never sees the storage credential — it only ever talks to our
 * own route, which does the pinning and returns a URI.
 */

import { fitImage, fmtBytes } from "./image-fit";

/**
 * What a request carrying the art is allowed to weigh.
 *
 * The ceiling above these is not ours: a serverless function on Vercel is never
 * handed a request body over 4.5 MB, and the rejection happens at the platform,
 * so no code of ours is running to turn it into a sentence. These sum to well
 * under that rather than up to it, because the multipart framing, the boundaries
 * and seven text fields all ride in the same body — and because a limit met
 * exactly is a limit that fails on the next thing added to the form.
 *
 * They are ceilings, not targets. `fitImage` re-encodes at the dimensions the
 * pages actually draw, which lands a photograph in the low hundreds of kilobytes,
 * so what these numbers really decide is when an image that *cannot* be
 * re-encoded — an SVG, an animated GIF — has to be refused.
 */
export const LOGO_BUDGET = 1_500_000;
export const BANNER_BUDGET = 2_000_000;
/** Both of the above plus the form, still comfortably inside the platform's 4.5 MB. */
export const REQUEST_BUDGET = 4_000_000;

/**
 * The longest edge each image keeps.
 *
 * From what the app draws, doubled for retina and rounded up to a familiar
 * number. The logo appears at 120px at its largest (the token page header) and at
 * 30px in the swap picker; the banner spans the token page at up to ~960px. Going
 * past this stores detail nothing will ever render.
 */
const LOGO_EDGE = 1024;
const BANNER_EDGE = 1920;

/**
 * Fit a picked image for upload. Called when the file is *chosen*, not when the
 * form is submitted, so that the tile preview, the size named under it and the
 * bytes eventually pinned are all the same file — and so a picture that cannot be
 * made to fit says so while the reader is still looking at the field.
 */
export const fitLogo = (file: File) =>
  fitImage(file, { edge: LOGO_EDGE, budget: LOGO_BUDGET, label: "Logo" });

export const fitBanner = (file: File) =>
  fitImage(file, { edge: BANNER_EDGE, budget: BANNER_BUDGET, label: "Banner" });

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
  // A backstop rather than the fix — both files were fitted at pick time. It
  // catches a caller that skipped that, and it costs one comparison to fail here
  // with a sentence instead of at the platform with a status code.
  const bytes = m.logo.size + (m.banner?.size ?? 0);
  if (bytes > REQUEST_BUDGET) {
    throw new Error(
      `The logo and banner come to ${fmtBytes(bytes)} together, over the ${fmtBytes(REQUEST_BUDGET)} an upload can carry. Pick a smaller one.`,
    );
  }

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
    // A body over the platform's limit never reaches the route, so there is no
    // JSON to read — Vercel answers this one itself, in HTML. Say what happened
    // rather than showing the reader a status code.
    if (res.status === 413 && !json?.error) {
      throw new Error(
        `The images were too large for the upload to reach the server — it has to come to under ${fmtBytes(REQUEST_BUDGET)}.`,
      );
    }
    throw new Error(json?.error ?? `Upload failed (${res.status}).`);
  }
  if (!json?.uri) {
    throw new Error("Upload succeeded but returned no URI.");
  }
  return json.uri;
}
