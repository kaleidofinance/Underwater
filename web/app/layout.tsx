import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WaterLayer } from "@/components/water/WaterLayer";
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

const TITLE = "underwater.fun — meme launchpad on InkChain";
const DESCRIPTION =
  "Launch a token on a bonding curve. Graduate to a real pool with burned liquidity. Built on InkChain.";

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
