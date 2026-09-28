import type { Metadata } from "next";
import { RefRedirect } from "@/components/zec/RefRedirect";

/**
 * A referral link, underwater.fun/r/CODE. X and Discord read this page's
 * metadata to unfurl the person's card (./opengraph-image.tsx); a person
 * clicking through is sent on to the waitlist with the code applied.
 */
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const title = "Join me on underwater.fun, the meme launchpad coming to Zcash";
  const description = `Join the waitlist with code ${code.toUpperCase()} and we both earn points.`;
  return {
    title,
    description,
    openGraph: { title, description, url: `/r/${code}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function Referral({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RefRedirect code={code} />;
}
