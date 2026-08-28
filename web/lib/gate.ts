/**
 * The waterdrop gate: whether the app is shut, and what opens it.
 *
 * The first thing this site shows the public is the waitlist registration, and
 * nothing else. The launchpad is finished and it is behind the blur; it is not
 * finished being *validated*, and a market you cannot trade on yet is a worse
 * first impression than one you cannot see yet.
 *
 * Worth being exact about what this enforces, because the name suggests more than
 * it does: it is a **presentation** gate. Every route still renders, all of the
 * code still ships in the bundle, and anyone who reads it — or who turns
 * JavaScript off — reaches the app. Making it real means refusing the routes in
 * middleware, before any HTML is sent. Nothing behind the blur is a secret, so
 * presentation is what this needs; if that ever stops being true, this is not the
 * mechanism to reach for.
 *
 * Which is also what the key below is: convenience for the team, not a
 * credential. `NEXT_PUBLIC_` means it is inlined into the client bundle by
 * definition — that is what lets a static build check it at all — so treat it as
 * unlisted, never as private, and don't reuse a real secret for it.
 */

/// Anything that reads as "no". One canonical spelling would be enough, except
/// the failure mode is silent and one-directional: a deploy that meant to open
/// and set `false` would stay shut and nobody would notice for a day.
const OFF = new Set(["off", "0", "false", "no"]);

/**
 * Shut unless the environment says otherwise, deliberately.
 *
 * The default has to be the safe one, because the dangerous state here is the
 * app being *reachable* by accident: a fresh deploy, a preview branch, or a
 * Vercel project whose env vars have not been filled in yet all resolve to
 * `undefined`, and every one of them should show the registration form rather
 * than an unannounced launchpad. Opening the app is then an explicit act —
 * `NEXT_PUBLIC_GATE=off` plus a redeploy, since this is read at build time.
 */
export const GATE_ON = !OFF.has(
  (process.env.NEXT_PUBLIC_GATE ?? "").trim().toLowerCase(),
);

/// Empty means no bypass exists, which is the right reading of an unset variable:
/// a missing key must not open the gate, and it must not make `?key=` with no
/// value work either.
export const GATE_KEY = (process.env.NEXT_PUBLIC_GATE_KEY ?? "").trim();

const PARAM = "key";
const STORE = "underwater.gate";

// Storage throws rather than returning null in a locked-down browser (Safari
// private mode), and the gate is not worth taking the page down for — same
// reasoning as the chain preference in components/ChainSync.tsx.
function remember(ok: boolean) {
  try {
    if (ok) window.localStorage.setItem(STORE, "open");
    else window.localStorage.removeItem(STORE);
  } catch {
    // Then the key works for this page load only.
  }
}

function remembered(): boolean {
  try {
    return window.localStorage.getItem(STORE) === "open";
  } catch {
    return false;
  }
}

/**
 * Has this browser been let through?
 *
 * `?key=…` once, and then it is remembered — without that a bypass is unusable,
 * because a `<Link>` navigation builds a fresh URL and drops the query string on
 * the first click. A key that does *not* match clears the memory, which gives the
 * team a way to put the gate back up and check what the public sees.
 *
 * The param is stripped from the address bar either way. It cannot be unsent, but
 * it can be kept out of the URL that gets screenshotted, pasted into a ticket or
 * sent along as a `Referer`. Only `key` is removed: `ChainSync` keeps `chain`
 * there and WaitlistPanel reads `ref` out of the same query string, so this must
 * rewrite the URL rather than replace it.
 */
export function readBypass(): boolean {
  if (typeof window === "undefined") return false;

  const url = new URL(window.location.href);
  const given = url.searchParams.get(PARAM);
  if (given === null) return remembered();

  url.searchParams.delete(PARAM);
  window.history.replaceState(null, "", url);

  const ok = GATE_KEY !== "" && given === GATE_KEY;
  remember(ok);
  return ok;
}
