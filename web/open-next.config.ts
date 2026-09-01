import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * Required by `@opennextjs/cloudflare`, and deliberately empty.
 *
 * The adapter refuses to build without this file — 1.20.5 hard-errors rather than
 * generating a default, which older guidance said it would. So its presence is not a
 * statement that we need anything from it.
 *
 * What would normally go here is `incrementalCache`, and the reason there is none is
 * structural rather than a shortcut: that cache exists to hold ISR and SSG revalidation
 * output, and this app has neither and cannot have either. A route-level `revalidate`
 * export makes Next prerender the route at build time, which the Vercel prebuilt builder
 * then cannot reconcile — "Unable to find lambda for route" — so every handler in
 * `app/api/` is `force-dynamic` by necessity. Nothing revalidates, so there is nothing
 * for an incremental cache to hold, and an R2 bucket here would be a bucket that is
 * never written to. Same reasoning retires `tagCache` (D1) and `queue`: both serve
 * `revalidateTag`/`revalidatePath`, neither of which this app calls.
 *
 * The caching this app actually needs is the CDN layer, which the adapter does not
 * provide for SSR — "SSR route will work out of the box without any caching config",
 * meaning uncached. That is `lib/edge-cache.ts`, and it lives in the request path rather
 * than in this config because it is not something the adapter models.
 */
export default defineCloudflareConfig();
