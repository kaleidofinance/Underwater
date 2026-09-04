import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { WaterLayer } from "@/components/water/WaterLayer";
import { REPO_URL, SECURITY_URL } from "@/lib/links";
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
 *
 * The literal is the last resort and it is the brand domain, held since
 * 2026-09-04. It used to be `www.gounderwater.fun`, which was the site's real
 * home until the name became available — and the reason that mattered is that
 * `VERCEL_PROJECT_PRODUCTION_URL` still answers with whichever domain the project
 * has marked production, so this fallback is not the only thing that has to be
 * right. If a card comes back naming the wrong host, that variable is where to
 * look, not this line.
 */
const SITE = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://www.underwater.fun"),
);

/**
 * What a link to the site says it is.
 *
 * X and Discord print these two lines *under* the card, so the words and the
 * artwork have to be about the same thing. They are: this is the launchpad's
 * title over app/opengraph-image.tsx's launchpad poster, and /waterdrop carries
 * its own pair — app/waterdrop/layout.tsx and app/waterdrop/opengraph-image.tsx
 * — so the registration link unfurls as the registration and not as this.
 *
 * These two used to follow the pre-launch gate, saying "join the waterdrop" while
 * the app was behind glass. The gate is retired, so the front door is the
 * launchpad again and this says so unconditionally.
 *
 * No chain in either string. They used to say "on InkChain", on the grounds that a
 * brand word survives a visitor landing on either Ink network where a network name
 * would not. The launchpad now deploys to more than one chain *family*, so the brand
 * word does not survive that either — and these strings are baked at build time,
 * before anything knows which chain the visitor will connect to. Which network a
 * page is actually reading is the switcher's job to say, live, in the UI. See
 * lib/chains.ts for the registry that makes that the only honest place for it.
 */
const TITLE = "underwater.fun — meme token launchpad";
const DESCRIPTION =
  "Launch a token on a bonding curve. Graduate to a real pool with burned liquidity, on whichever chain you connect to.";

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
        <Providers>{children}</Providers>
        {/* Site-wide footer, under every page. The primary nav (Market, Launch,
            Plates, Waterdrop, Profile, Swap) lives in the masthead —
            components/Chrome.tsx. This strip carries the secondary links: the
            documentation, the source, the security policy, and the project's X
            handle.

            All four are load-bearing beyond being useful, and the Source link
            used to be a 404 (`github.com/underwater-fun`, an account that does not
            exist) — see lib/links.ts. The outbound three are the only external
            links in the served HTML, so they are the whole of what an automated
            abuse feed can check about who runs this site, on a page whose central
            control is Connect Wallet. A dead one reads worse than none.

            Docs goes first and is the only internal one, so it is a <Link> rather
            than an <a> and carries no ↗ — it prefetches and it does not leave the
            site. It is first because it is the one a visitor who does not already
            know what this is should click.

            All four are reachable from every page now. While the pre-launch gate
            was up this footer was a sibling of it and useInertBehind marked it
            inert behind the glass, so the gate carried its own copy of the
            outbound links; that duplicate went with the gate. Docs never had one
            — a link to a page rendering behind the same blur is worse than no
            link — which is why it is here and only here. */}
        <footer className="site-footer">
          <Link href="/docs">Docs</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source ↗
          </a>
          <a href={SECURITY_URL} target="_blank" rel="noreferrer">
            Security ↗
          </a>
          <a href="https://x.com/underwaterxyz" target="_blank" rel="noreferrer">
            @underwaterxyz ↗
          </a>
        </footer>
      </body>
    </html>
  );
}
