"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { fmtZec } from "@/lib/zec/format";
import { useZecKey, useZecLive, useZecMe } from "@/lib/zec/hooks";

/** Header and live stream for every /zec page. */
export function ZecShell({ children }: { children: ReactNode }) {
  useZecLive();
  const pathname = usePathname();
  const key = useZecKey();
  const me = useZecMe(key);
  const active = (href: string) => (href === "/zec" ? pathname === "/zec" : pathname.startsWith(href));

  return (
    <div className="shell">
      <header className="top">
        <div className="wordmark">
          <Logo className="logo-mark" />
          under<em>water</em>.fun <span className="zec-badge">ZEC</span>
        </div>
        <div className="mast-side">
          <div className="mast-meta">
            <ThemeToggle />
            <Link href="/zec/account" className={me.data ? "account" : "primary account"}>
              <b>{me.data ? `${fmtZec(me.data.balance)} ZEC` : "Deposit ZEC"}</b>
              <span>{key ? `acct ${key.account.slice(0, 6)}…` : "making your key…"}</span>
            </Link>
          </div>
          <nav className="nav">
            <Link href="/zec" data-active={active("/zec")}>
              Market
            </Link>
            <Link href="/zec/create" data-active={active("/zec/create")}>
              Launch
            </Link>
            <Link href="/zec/account" data-active={active("/zec/account")}>
              Account
            </Link>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
