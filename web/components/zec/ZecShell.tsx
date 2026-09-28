"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { fmtZec } from "@/lib/zec/format";
import { useZecKey, useZecLive, useZecMe } from "@/lib/zec/hooks";

/**
 * Which Zcash network the API trades on, baked in at build time. Anything but
 * "mainnet" is labelled testnet, so a misconfigured build errs toward saying so.
 */
const TESTNET = process.env.NEXT_PUBLIC_ZEC_NETWORK !== "mainnet";

/** Header and live stream for every page. */
export function ZecShell({ children }: { children: ReactNode }) {
  useZecLive();
  const pathname = usePathname();
  const key = useZecKey();
  const me = useZecMe(key);
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`) || (href === "/app" && pathname.startsWith("/token"));

  return (
    <div className="shell">
      <header className="top">
        <Link href="/" className="wordmark">
          <Logo className="logo-mark" />
          under<em>water</em>.fun <span className="zec-badge">{TESTNET ? "ZEC TESTNET" : "ZEC"}</span>
        </Link>
        <div className="mast-side">
          <div className="mast-meta">
            <ThemeToggle />
            <Link href="/account" className={me.data ? "account" : "primary account"}>
              <b>{me.data ? `${fmtZec(me.data.balance)} ZEC` : "Deposit ZEC"}</b>
              <span>{key ? `acct ${key.account.slice(0, 6)}…` : "making your key…"}</span>
            </Link>
          </div>
          <nav className="nav">
            <Link href="/app" data-active={active("/app")}>
              Market
            </Link>
            <Link href="/create" data-active={active("/create")}>
              Launch
            </Link>
            <Link href="/account" data-active={active("/account")}>
              Account
            </Link>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
