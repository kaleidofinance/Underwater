import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WaterLayer } from "@/components/water/WaterLayer";
import { THEME_BOOT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "underwater.fun — meme launchpad on Ink",
  description:
    "Launch a token on a bonding curve. Graduate to a real pool with burned liquidity. Built on Ink.",
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
        {/* The same water as a WebGPU shader, behind `?shader=1`. Renders nothing
            unless the flag is set, and the two divs above are what the server
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
