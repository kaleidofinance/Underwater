import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

/**
 * Cloudflare-only companion to wrangler.jsonc. Never read by the Vercel build.
 *
 * This file was empty for most of the spike, on the reasoning that an incremental
 * cache exists to hold *revalidation* output and this app has none — no `revalidate`
 * export anywhere, every `app/api/` handler `force-dynamic` by necessity. That was
 * half right, and the wrong half cost a day.
 *
 * The incremental cache also holds **prerendered** output, and this app has plenty:
 * `next build` writes 14 entries to `.open-next/cache/<buildId>/`, among them
 * `index`, `create`, `docs`, `plates`, `profile`, `swap`, `mint`, `waterdrop`, and
 * the two build-time share cards `opengraph-image` and `waterdrop/opengraph-image`.
 * With no cache configured the adapter has nowhere to *read* those bodies from, so it
 * re-renders every one of them on every request — while still attaching the
 * prerender manifest's `initialHeaders`, which is why the root card came back looking
 * cached (`max-age=31536000, immutable`) despite having just been rendered from
 * scratch.
 *
 * How that surfaced: `/waterdrop/opengraph-image` returned 524 after 100.8s on the
 * edge, and `/token/[address]/opengraph-image` needed a CPU-limit raise to finish at
 * all. Satori laying out with Yoga plus resvg encoding a 1200x630 PNG is the most
 * expensive thing in this app, and it was being paid per request for two cards whose
 * bytes were already sitting in the build output. The CPU raise in wrangler.jsonc is
 * still right — the *token* card genuinely cannot be prerendered, since addresses are
 * unbounded — but it was treating a symptom for these two.
 *
 * `staticAssetsIncrementalCache` is read-only and backed by the same `ASSETS` binding
 * the fonts load through, and read-only is the correct shape rather than a
 * compromise: the original reasoning holds for *writes*, so a cache that cannot write
 * loses nothing here. Its own docs say to use it for apps that "do NOT want
 * revalidation and ONLY want to serve prerendered data", which is this app stated
 * precisely. Entries land in `.open-next/assets/cdn-cgi/_next_cache/`, which is
 * Worker static assets and so costs no bundle size, and `cdn-cgi/` is reachable only
 * by the Worker rather than being publicly servable.
 *
 * Chosen over R2 and KV for the same reason: both are write-capable stores that would
 * never be written to, each costing a binding, a provisioning step, and per-read
 * billing to hold bytes already being uploaded alongside the Worker.
 *
 * **The deploy command matters, and silently.** `populateCache` runs from
 * `opennextjs-cloudflare deploy`/`upload`/`preview` — *not* from
 * `opennextjs-cloudflare build`. A plain `wrangler deploy` therefore ships a Worker
 * that asks for cache entries nobody copied into assets, every lookup misses, and the
 * app behaves exactly as it did with this file empty. No error either way.
 *
 * Still absent, and this part of the old reasoning stands unchanged: no `tagCache`
 * (D1) and no `queue`, because both serve `revalidateTag`/`revalidatePath` and
 * neither is called anywhere in this app. No composable cache either — this override
 * throws on it by design, and nothing here uses `"use cache"`.
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
