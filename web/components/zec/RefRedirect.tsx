"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { REF_KEY } from "@/lib/zec/waitlist";

/** Keep the referral code, then send the visitor to the whitelist. */
export function RefRedirect({ code }: { code: string }) {
  const router = useRouter();
  useEffect(() => {
    const clean = code.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
    try {
      if (clean.length === 6) localStorage.setItem(REF_KEY, clean);
    } catch {
      // Private mode: the code still rides along in the URL.
    }
    router.replace(`/?ref=${clean}`);
  }, [code, router]);
  return <div className="empty">Taking you to the whitelist…</div>;
}
