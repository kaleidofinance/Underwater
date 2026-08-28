"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

/**
 * The flag, and the chunk boundary.
 *
 * Two jobs, and they have to be in a file that does not import `vgpu` for either
 * of them to be worth anything. The root layout pulls this in on every route, so
 * an `import { init } from "vgpu"` here would put the library in the shared
 * client bundle for the whole site — a `if (enabled)` at runtime cannot remove a
 * static import, and the flag would save nothing but the drawing. Reaching
 * WaterCanvas through `dynamic()` instead puts vgpu in a chunk of its own, which
 * is requested when the flag is on and never otherwise.
 *
 * `ssr: false` on top of that means the server emits no markup for the canvas at
 * all, so there is nothing for hydration to compare and disagree about. The CSS
 * water in globals.css is what the server sends, always, and it stays on screen
 * until the shader is actually running.
 *
 *   /?shader=1   turn it on, and remember
 *   /?shader=0   turn it off, and forget
 *
 * A query param rather than an env var because the point is comparing the two
 * live: `NEXT_PUBLIC_` values are baked at build time, so flipping one would mean
 * a rebuild and a redeploy per look. This flips on the deployed site, in one
 * navigation, and persists to localStorage so it survives the next click.
 */
const WaterCanvas = dynamic(() => import("./WaterCanvas"), { ssr: false });

const KEY = "uw:shader";

export function WaterLayer() {
  const [on, setOn] = useState(false);

  // Post-mount, and reading `location.search` directly rather than through
  // `useSearchParams` — that hook opts its whole subtree out of static rendering
  // and forces a Suspense boundary, which on this app's root layout would be
  // every route. Nothing here needs to be a hook: the flag is read once, on the
  // client, in a component the server never rendered.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("shader");
      if (q === "1") localStorage.setItem(KEY, "1");
      else if (q === "0") localStorage.removeItem(KEY);
      setOn(localStorage.getItem(KEY) === "1");
    } catch {
      // Private mode, blocked storage. The query param alone still decides.
      setOn(new URLSearchParams(window.location.search).get("shader") === "1");
    }
  }, []);

  return on ? <WaterCanvas /> : null;
}
