/**
 * The curve maths, imported rather than restated.
 *
 * `web/lib/curve.ts` is a bigint-for-bigint mirror of `src/lib/CurveMath.sol` with
 * zero imports of its own, which is what makes it importable across a package
 * boundary that has no workspace between it. Reaching over the boundary is uglier
 * than a shared package would be and much better than the alternative: a stored
 * market cap and a rendered one derived from two copies of the same division agree
 * until someone edits one of them.
 *
 * The same argument the app already makes for itself — `lib/og-data.ts` imports these
 * so a share card cannot disagree with the page it links to.
 */
export { marketCapWei, progressBps, spotPriceE18 } from "../../web/lib/curve";
