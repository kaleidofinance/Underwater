/**
 * The theme override: where it is stored, and the script that restores it.
 *
 * Its own module because the two halves cannot share one otherwise. The boot
 * script is rendered by app/layout.tsx, which is a server component, and the
 * switch that writes the value is components/ThemeToggle.tsx, which is a client
 * one — and a `"use client"` module's exports reach the server as client
 * references rather than as values, so importing the key from there would hand the
 * layout a proxy instead of a string. Without this file the key would be written
 * out twice, once inside the script's source text and once in the component, with
 * nothing to catch them drifting apart.
 */

/** The localStorage key. Absent means no override: follow the OS. */
export const THEME_KEY = "theme";

/**
 * Runs before the first paint, which is the whole point of it: without this the
 * page paints in the OS theme and then jumps to the stored one when React mounts.
 * It has to be inline and it has to be in `<head>` — a deferred or body script is
 * already too late.
 *
 * `try` because Safari's private mode throws on `localStorage` rather than
 * returning null, and a theme is not worth an uncaught exception at boot.
 */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
