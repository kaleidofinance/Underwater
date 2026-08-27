"use client";

import { useEffect, useState } from "react";

/**
 * Viewport questions the stylesheet cannot answer.
 *
 * Almost all of the responsive work in this app belongs in CSS, and lives there.
 * This is for the exception: when the *amount of data* rendered has to change,
 * not its arrangement. A paginated list is the case — a page size is a number in
 * JavaScript, and a media query cannot slice an array.
 */

/**
 * True while the viewport matches `query`.
 *
 * Starts `false` on purpose. The server has no viewport, so any other initial
 * value would be a guess that the first client paint then contradicts; false
 * means "assume the roomy layout until told otherwise", and the correction
 * arrives in the effect on the same tick as hydration.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * The phone breakpoint, kept as one constant because it has to agree with the
 * stylesheet: the row layout changes at 640px in `globals.css`, and a page size
 * that changed at some other width would leave one of the two wrong.
 */
export const NARROW = "(max-width: 640px)";

/** Sugar for the only breakpoint anything in here needs so far. */
export const useNarrow = () => useMediaQuery(NARROW);
