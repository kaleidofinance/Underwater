import type { Metadata } from "next";
import type { ReactNode } from "react";
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
