import { ImageResponse } from "next/og";
import { CARD_SIZE, Card, type CardData } from "@/lib/zec/card";

const ZEC_API = (process.env.NEXT_PUBLIC_ZEC_API ?? "http://localhost:8811").replace(/\/+$/, "");

export const size = CARD_SIZE;
export const contentType = "image/png";
export const alt = "A referral card for the underwater.fun whitelist";

/** One person's card: their handle, place in line and points, read live from the API. */
export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let data: CardData = {};
  if (/^[A-Za-z2-9]{6}$/.test(code)) {
    try {
      const res = await fetch(`${ZEC_API}/api/waitlist/${code.toUpperCase()}`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (res.ok) data = (await res.json()) as CardData;
    } catch {
      // The API being slow must not break the unfurl: fall back to the site's own card.
    }
  }
  return new ImageResponse(<Card {...data} />, size);
}
