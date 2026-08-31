import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * What a link to /waterdrop says it is.
 *
 * A layout and not the page, because ./page.tsx is a client component and Next
 * only collects `metadata` from server modules. It renders nothing of its own —
 * the page is already a full page — so this file is the two lines of text under the
 * share card and nothing else.
 *
 * They lived in app/layout.tsx until the pre-launch gate was retired. While the
 * gate was up the registration was the only reachable screen, so the *root* title
 * said "join the waterdrop" and the root card was the waterdrop poster; now that
 * the app is open the root says launchpad and this route carries the registration's
 * own pair. The card beside it is ./opengraph-image.tsx.
 *
 * The description says the allowlist is *drawn from* the registrants rather than
 * that registering gets you on it, because registration is intake and not
 * entitlement — ./page.tsx has the sentence in full. An unfurl is quoted and
 * screenshotted far from the page that would qualify it, so it has to be true on
 * its own.
 */
const TITLE = "underwater.fun — join the waterdrop";
const DESCRIPTION =
  "One transaction puts your wallet in the waterdrop on InkChain — no form, and no email. The plates allowlist is drawn from everyone who registers, under criteria published up front.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "underwater.fun",
    title: TITLE,
    description: DESCRIPTION,
    url: "/waterdrop",
  },
  twitter: {
    // Load-bearing, same as the root: without it X renders `og:image` as a small
    // square thumbnail beside the text, which crops a 1200×630 plate to an
    // illegible middle.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    site: "@underwaterxyz",
    creator: "@underwaterxyz",
  },
};

export default function WaterdropLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
