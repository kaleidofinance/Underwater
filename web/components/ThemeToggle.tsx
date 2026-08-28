"use client";

import { THEME_KEY } from "@/lib/theme";

/**
 * The light/dark switch: the half that writes. The half that reads the value
 * back on the next visit is the boot script in app/layout.tsx's `<head>`, which
 * has to run before the page paints — see lib/theme.ts, which both halves share
 * so the key is only spelled once.
 *
 * Holds no React state, on purpose. `<html data-theme>` is the state: the script
 * restores it, the sheet reads it, and this button flips it. A `useState` mirror
 * of it would have to start empty on the server and fill in after mount — a
 * value the server cannot know, rendered into markup, which is the shape of bug
 * components/Modal.tsx was just fixed for. There is nothing here for React to
 * hydrate against.
 *
 * Two states, not three. The way back to "follow the OS" is to choose what the OS
 * already asks for: that stores nothing and clears the attribute, because an
 * override that agrees with the system is not an override — and one saved as a
 * literal "dark" would outlive the day its owner switched their machine to light.
 */

type Theme = "light" | "dark";

function osTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** What the visitor is actually looking at: the override, or the OS under it. */
function shownTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  return attr === "light" || attr === "dark" ? attr : osTheme();
}

export function ThemeToggle() {
  function flip() {
    const next: Theme = shownTheme() === "dark" ? "light" : "dark";
    const root = document.documentElement;
    if (next === osTheme()) {
      localStorage.removeItem(THEME_KEY);
      root.removeAttribute("data-theme");
    } else {
      localStorage.setItem(THEME_KEY, next);
      root.dataset.theme = next;
    }
  }

  return (
    <button
      type="button"
      className="mast-icon"
      onClick={flip}
      title="Switch between the light and dark theme"
      aria-label="Switch between the light and dark theme"
    >
      {/* Both marks ship; the sheet shows whichever one names the theme you
          would get by pressing. Chosen in CSS rather than from a mounted flag
          because the first render cannot read the OS preference — the icon
          would land wrong for everyone whose machine disagrees with the
          default and correct itself a frame later. */}
      <svg
        className="th-sun"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="4.3" fill="currentColor" />
        <path
          d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      <svg
        className="th-moon"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"
        />
      </svg>
    </button>
  );
}
