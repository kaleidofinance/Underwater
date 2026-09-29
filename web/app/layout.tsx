import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WaterLayer } from "@/components/water/WaterLayer";
import { SoonLink } from "@/components/SoonLink";
import { X_URL } from "@/lib/links";
import { THEME_BOOT } from "@/lib/theme";
import { Providers } from "./providers";
import "./globals.css";
import "./zec.css";

/**
 * Where the site lives, for resolving share metadata to absolute URLs.
 * `VERCEL_PROJECT_PRODUCTION_URL` names the production domain on every
 * deployment, previews included, so a preview's links still point at the
 * canonical host.
 */
const SITE = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://www.underwater.fun"),
);

const TITLE = "underwater.fun — the meme launchpad is coming to Zcash";
const DESCRIPTION =
  "Launch a meme token on Zcash in seconds and trade it instantly. Join the whitelist and earn points for every friend you bring.";

export const metadata: Metadata = {
  metadataBase: SITE,
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "underwater.fun", title: TITLE, description: DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, site: "@underwaterxyz", creator: "@underwaterxyz" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* First in the head, ahead of the fonts: a stored theme has to be on
            <html> before anything paints. The switch that writes it is
            components/ThemeToggle.tsx; both read the key from lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Fraunces for display, Spectral for prose, JetBrains Mono for every number. */}
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
        {/* Marine snow: two parallax layers of particulate sinking through the light. */}
        <div className="motes" aria-hidden="true">
          <span />
          <span />
        </div>
        {/* The same water as a WebGPU shader, behind `?shader=1`. */}
        <WaterLayer />
        <Providers>{children}</Providers>
        <footer className="site-footer">
          {/* The code is private for now: these open once it's published. */}
          <SoonLink label="Source" />
          <SoonLink label="Security" />
          <a href={X_URL} target="_blank" rel="noreferrer">
            @underwaterxyz ↗
          </a>
        </footer>
      </body>
    </html>
  );
}
