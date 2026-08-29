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
/// (see CRITERIA_URL in components/WaitlistPanel.tsx).
export const REPO_URL = "https://github.com/kaleidofinance/Underwater";

/// The security policy: how to report, what is in scope, and the exhaustive list
/// of hostnames and accounts that are actually ours. Served as a link from the
/// footer and named as `Policy` by public/.well-known/security.txt, so a reader
/// and a scanner arrive at the same document.
export const SECURITY_URL = `${REPO_URL}/blob/main/SECURITY.md`;
