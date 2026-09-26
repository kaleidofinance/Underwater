import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ZecShell } from "@/components/zec/ZecShell";
import "./zec.css";

export const metadata: Metadata = {
  title: "underwater.fun — ZEC meme launchpad",
  description: "Launch a meme token on Zcash in seconds and trade it instantly. Deposit ZEC once; everything after is instant.",
};

export default function ZecLayout({ children }: { children: ReactNode }) {
  return <ZecShell>{children}</ZecShell>;
}
