/**
 * The project's X account, in the control row.
 *
 * The footer keeps its copy of the same handle — see app/layout.tsx. They are
 * different jobs: this is a mark you spot without reading, that is a line of fine
 * print for whoever scrolled to the bottom looking for it. The handle is written
 * out in both places rather than shared through a constant, which is two places
 * to change and worth saying out loud.
 *
 * The mark is drawn rather than typed. "𝕏" is a mathematical double-struck
 * capital, and the fonts this site loads do not carry it, so the glyph would fall
 * back to whatever the OS had — a different shape on every machine, for the one
 * element that has to be recognisable at 13px.
 */
export function XLink() {
  return (
    <a
      href="https://x.com/underwaterxyz"
      target="_blank"
      rel="noreferrer"
      className="mast-icon"
      title="@underwaterxyz on X"
      aria-label="@underwaterxyz on X"
    >
      <svg
        viewBox="0 0 1200 1227"
        width="13"
        height="13"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M714.163 519.284 1160.89 0h-105.86L667.137 450.887 357.328 0H0l468.492 681.821L0 1227h105.866l409.625-476.782L842.672 1227H1200L714.163 519.284Zm-144.998 168.544L521.697 619.934 144.011 79.694h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.828Z"
        />
      </svg>
    </a>
  );
}
