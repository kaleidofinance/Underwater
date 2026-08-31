/**
 * The curve maths, imported rather than restated.
 *
 * `web/lib/curve.ts` is a bigint-for-bigint mirror of `src/lib/CurveMath.sol` with
 * zero imports of its own. A stored market cap and a rendered one derived from two
 * copies of the same division agree until someone edits one of them, so there is only
 * ever one copy anybody edits — the app's.
 *
 * The import goes through `vendor/curve.ts` instead of reaching up into `../../web`
 * because a host builds this directory on its own and nothing above it exists there.
 * `scripts/curve.mjs` writes the vendored file from the original before every dev and
 * start, and refuses to run if the original has grown imports; see its header for the
 * whole bargain.
 *
 * The same argument the app already makes for itself — `lib/og-data.ts` imports these
 * so a share card cannot disagree with the page it links to.
 */
export { marketCapWei, progressBps, spotPriceE18 } from "../vendor/curve";
