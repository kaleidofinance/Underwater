import type { ReactNode } from "react";
import { ZecShell } from "@/components/zec/ZecShell";

/** The trading app: header, balance and the live stream. The waitlist at / has none of it. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <ZecShell>{children}</ZecShell>;
}
