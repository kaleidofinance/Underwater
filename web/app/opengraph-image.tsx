import { ImageResponse } from "next/og";
import { CARD_SIZE, Card } from "@/lib/zec/card";

export const size = CARD_SIZE;
export const contentType = "image/png";
export const alt = "underwater.fun: the meme launchpad is coming to Zcash";

export default function Image() {
  return new ImageResponse(<Card />, size);
}
