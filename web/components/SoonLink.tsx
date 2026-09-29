"use client";

import { useEffect, useState } from "react";

/**
 * A footer entry for a page that isn't public yet. It reads like its
 * neighbouring links, and a click says "coming soon" in place instead of
 * leaving the site.
 */
export function SoonLink({ label }: { label: string }) {
  const [soon, setSoon] = useState(false);

  useEffect(() => {
    if (!soon) return;
    const t = setTimeout(() => setSoon(false), 1800);
    return () => clearTimeout(t);
  }, [soon]);

  return (
    <button type="button" className="soon-link" onClick={() => setSoon(true)} aria-live="polite">
      {soon ? "Coming soon" : label}
    </button>
  );
}
