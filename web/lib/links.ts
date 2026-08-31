/**
 * Where the project is, off the site.
 *
 * Three links live here rather than being typed where they are used, and the
 * reason is a bug that shipped: the footer's "Contracts" link pointed at
 * `github.com/underwater-fun` — an account that does not exist — so the one place
 * the site offered to show its source answered 404 in production. On a
 * wallet-connect page that is not a broken link, it is a phishing signal, and it
 * is precisely the signal an automated abuse feed reads. A hand-typed URL in two
 * files can be wrong in one of them; this cannot.
 *
 * The X handle deliberately stays out of this module. components/XLink.tsx writes
 * it out and says why in its own docblock, and moving it here would be a change to
 * a decision somebody made on purpose rather than a fix to one that was wrong.
 */

/// The source. Public, and the same repository the criteria document is pinned in
/// (see `CRITERIA_URL` below).
export const REPO_URL = "https://github.com/kaleidofinance/Underwater";

/**
 * The published selection criteria.
 *
 * Linked at the repository rather than served from `public/`: the document's
 * keccak256 is what gets committed on chain, so a second copy is a second thing to
 * hash, and the file somebody checks should be the one the commitment was taken
 * over. It lives at the repo root, which `web/public/` does not serve — so the
 * `/ALLOWLIST.md` this used to point at answered 404 in production.
 *
 * Pinned to a commit, not `main`, for the same reason it is not copied: the page
 * beside this link tells the reader to hash what they find and compare 32 bytes
 * against the chain. A `blob/main` link is a moving target — one edit after the hash
 * is committed and the link starts serving a document that cannot match, which reads
 * as us having changed the rules. This sha's bytes are the bytes the commitment was
 * taken over. Amending the criteria means a new hash and a new publication (see
 * ALLOWLIST.md "Publication"), so re-pin here in the same change.
 */
export const CRITERIA_URL = `${REPO_URL}/blob/2680a91b2fdac393826a89e35e64ee5ed6f5f11e/ALLOWLIST.md`;

/// The security policy: how to report, what is in scope, and the exhaustive list
/// of hostnames and accounts that are actually ours. Served as a link from the
/// footer and named as `Policy` by public/.well-known/security.txt, so a reader
/// and a scanner arrive at the same document.
export const SECURITY_URL = `${REPO_URL}/blob/main/SECURITY.md`;
