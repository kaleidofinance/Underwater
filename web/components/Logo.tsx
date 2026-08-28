/**
 * The drop, at wordmark size.
 *
 * Same geometry as app/icon.svg and deliberately not the same file. The favicon
 * is a document of its own, rendered on a browser tab we do not get to paint, so
 * it has to carry its own colours and its own `prefers-color-scheme` block. This
 * one sits inside the page and can read the roles instead: washi above the
 * waterline and goldleaf below become var(--ink) and var(--goldleaf). Which is
 * also why it follows the theme switch for free, where a copy of icon.svg's
 * media query would go on showing the OS theme after the switch was pressed.
 *
 * Cropped to the drop — the favicon's 64² box has 18 units of air either side of
 * it, and inline beside type that air would push the wordmark off the gutter
 * every other row on the page aligns to.
 *
 * Decorative: the wordmark says the name right beside it.
 */

/** The drop itself. Written twice below, clipped to either side of the surface. */
const DROP = `M31.4 7
   C 33.6 14.2 38.8 20.4 42.2 26.6
   C 45 31.6 46 35.2 46 38.4
   A 14 14 0 0 1 18 38.4
   C 18 35 19.1 31.4 22 26.4
   C 25.4 20.2 29.6 14 31.4 7 Z`;

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="17 6 30 47"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Clip rects stay in the favicon's coordinates — a viewBox crops the
            view, it does not move the user space the clip is measured in. */}
        <clipPath id="logo-air">
          <rect x="0" y="0" width="64" height="35" />
        </clipPath>
        <clipPath id="logo-sea">
          <rect x="0" y="35" width="64" height="29" />
        </clipPath>
        {/* The glint, as a paint the stylesheet can animate. `stop-opacity` is a
            real CSS property, so a band travelling down the drop is five stops
            brightening in turn — see `.logo-sheen-stop` in globals.css.

            Which also settles the question of what happens when animation is off:
            every stop rests at zero, the overlay is fully transparent, and the mark
            is exactly the two flat tones it is below. Nothing to guard. */}
        <linearGradient
          id="logo-sheen"
          gradientUnits="userSpaceOnUse"
          x1="18"
          y1="31"
          x2="46"
          y2="52"
        >
          <stop className="logo-sheen-stop" offset="0" stopColor="#fff" stopOpacity="0" />
          <stop className="logo-sheen-stop" offset="0.25" stopColor="#fff" stopOpacity="0" />
          <stop className="logo-sheen-stop" offset="0.5" stopColor="#fff" stopOpacity="0" />
          <stop className="logo-sheen-stop" offset="0.75" stopColor="#fff" stopOpacity="0" />
          <stop className="logo-sheen-stop" offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* The waterline is a change of tone, not a rule across the silhouette.
          icon.svg's comment has the reason: every variant that drew an actual
          line lost the drop at favicon size, the line cutting the tip off into a
          floating cone. A tone boundary survives the crop. */}
      <path fill="var(--ink)" clipPath="url(#logo-air)" d={DROP} />
      <path fill="var(--goldleaf)" clipPath="url(#logo-sea)" d={DROP} />
      {/* Gold half only. The ink half is the other tone of a deliberate two-tone
          mark, and a glint travelling across both would flatten the waterline back
          into one shape. */}
      <path fill="url(#logo-sheen)" clipPath="url(#logo-sea)" d={DROP} />
    </svg>
  );
}
