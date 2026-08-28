import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Gate } from "@/components/Gate";
import { WaterLayer } from "@/components/water/WaterLayer";
import { GATE_ON } from "@/lib/gate";
import { THEME_BOOT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

/**
 * Where the site lives, for resolving the share cards to absolute URLs.
 *
 * Crawlers will not follow a relative `og:image`, and Next needs `metadataBase`
 * to make one absolute. `VERCEL_PROJECT_PRODUCTION_URL` is set automatically on
 * every deployment and always names the production domain — not the
 * per-deployment one, which is what makes it safe to use here: a preview build's
 * card should still point at the canonical host rather than at a URL that stops
 * resolving when the next preview lands.
 */
const SITE = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://www.gounderwater.fun"),
);

/**
 * What a link to the site says it is, and it follows the gate.
 *
 * X and Discord print these two lines *under* the card, so a poster about the
 * waterdrop over a description of a launchpad nobody can reach is the unfurl
 * contradicting itself in the same 200 pixels. Both halves read `GATE_ON` — this
 * from lib/gate.ts, the artwork from app/opengraph-image.tsx — so the flag that
 * puts the app behind glass is also the one that changes what we say about it.
 *
 * It is the tab title too, which means the team browsing the app through the
 * bypass see "join the waterdrop" above a launchpad. That is the honest reading:
 * the build *is* gated, and they are the exception to it.
 *
 * "InkChain" and not a network name in the gated line, for the same reason the
 * waitlist's own "Active on InkChain" step keeps the brand word: the registration
 * is one deploy that moves from Sepolia to mainnet, and this string is baked at
 * build time by a variable that has nothing to do with which chain it is. Naming
 * one network here would be a claim the build cannot keep.
 */
const TITLE = GATE_ON
  ? "underwater.fun — join the waterdrop"
  : "underwater.fun — meme launchpad on InkChain";
const DESCRIPTION = GATE_ON
  ? "Register for the plates allowlist on InkChain. One transaction, from the wallet you want on the list — there is no form, and no email."
  : "Launch a token on a bonding curve. Graduate to a real pool with burned liquidity. Built on InkChain.";

export const metadata: Metadata = {
  metadataBase: SITE,
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "underwater.fun",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    // The image itself comes from app/opengraph-image.tsx, and a token page's
    // from app/token/[address]/opengraph-image.tsx. Next finds those by
    // convention and fills in `og:image` plus its width, height and alt.
  },
  twitter: {
    // Load-bearing. Without it X renders `og:image` as a small square thumbnail
    // beside the text, which crops a 1200×630 plate to an illegible middle. This
    // is what makes the card a poster.
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    site: "@underwaterxyz",
    creator: "@underwaterxyz",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* First in the head, ahead of the fonts, because a stored theme has to
            be on `<html>` before anything paints — a script that runs any later
            means everyone who picked the theme their machine disagrees with
            watches the page change colour. The switch that writes the value is
            components/ThemeToggle.tsx; both halves read the key from
            lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        {/* Same three families as the prototype: variable Fraunces for display,
            Spectral for prose, JetBrains Mono for every number. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..900,0..100,0..1&family=Spectral:ital,wght@0,300;0,400;1,300&family=JetBrains+Mono:wght@300;400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="water" aria-hidden="true" />
        <div className="shafts" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        {/* Marine snow: two parallax layers of particulate sinking through the
            light. Its own layer rather than a pseudo-element on .shafts, which
            cannot clip its children — see the motion section in globals.css. */}
        <div className="motes" aria-hidden="true">
          <span />
          <span />
        </div>
        {/* The same water as a WebGPU shader, behind `?shader=1`. Renders nothing
            unless the flag is set, and the three layers above are what the server
            sends either way — see components/water/WaterLayer.tsx. */}
        <WaterLayer />
        <Providers>
          {children}
          {/* The pre-launch gate: the app behind a blur with the waitlist
              registration in front of it. Inside the providers because it reads
              the chain and connects a wallet, and after `children` so it is the
              last thing in the body — though what puts it on top is its own
              z-index, not this. It renders nothing at all once
              `NEXT_PUBLIC_GATE=off`; see lib/gate.ts for what it does and does
              not enforce. */}
          <Gate />
        </Providers>
        {/* Site-wide footer, under every page. The primary nav (Market, Launch,
            Plates, Waterdrop, Profile, Swap) lives in the masthead —
            components/Chrome.tsx. This strip carries the secondary links: the
            contracts repo and the project's X handle. */}
        <footer className="site-footer">
          <a
            href="https://github.com/underwater-fun"
            target="_blank"
            rel="noreferrer"
          >
            Contracts ↗
          </a>
          <a href="https://x.com/underwaterxyz" target="_blank" rel="noreferrer">
            @underwaterxyz ↗
          </a>
        </footer>
      </body>
    </html>
  );
}
