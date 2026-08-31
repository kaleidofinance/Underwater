import { ImageResponse } from "next/og";
import {
  brandFonts,
  CARD,
  Datum,
  DIM,
  FONT,
  HAIR,
  Rubric,
  Scene,
  Wordmark,
} from "@/lib/og";
import { CURVE } from "@/lib/contracts";
import { fmtEth, fmtTokens } from "@/lib/format";

/**
 * The site's share card — the launchpad.
 *
 * Every link to underwater.fun used to unfurl bare: a title, a line of
 * description, and whatever grey rectangle the client draws when there is no
 * image. This is the poster instead, and it is the wordmark and the depth scene
 * because those are the two things the brand actually is.
 *
 * There used to be two cards here, and which one rendered followed the pre-launch
 * gate: while the gate was up the only thing anybody could reach was the
 * registration form, so the bare domain had to unfurl as the waterdrop. The gate
 * is retired, the app is the front door, and the waterdrop has the card it should
 * always have had once it was reachable — app/waterdrop/opengraph-image.tsx, with
 * its title and description beside it in app/waterdrop/layout.tsx. Next inherits
 * this one down to every route that has not defined its own.
 *
 * The card says only things that are constants in this repo: the curve's supply
 * and its graduation. Nothing here reads the chain, which is what lets Next render
 * it once at build and serve it as a static asset forever.
 */

export const alt = "underwater.fun — a meme launchpad on InkChain";
export const size = CARD;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<Launchpad />, {
    ...size,
    fonts: await brandFonts(),
  });
}

/**
 * The launchpad. The strip along the bottom is the curve's real constants, read
 * from lib/contracts.ts rather than typed out — not decoration: the one thing
 * worth saying to somebody who has never seen the site is what the mechanism is,
 * and "800M on the curve, graduates at 4 ETH, LP burned" is that in nine words. It
 * also cannot go stale — if the contract's constants change, so does the card.
 */
function Launchpad() {
  return (
    <Scene t={0.12}>
      <Rubric right="Meme launchpad · InkChain" />

      {/* The wordmark, given the middle of the card. `flexGrow` on the block
          rather than a fixed offset, so the data strip stays pinned to the
          bottom rule whatever the type does above it. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "center",
          gap: 26,
        }}
      >
        <Wordmark size={132} />

        <div
          style={{
            display: "flex",
            fontFamily: FONT.serif,
            fontWeight: 300,
            fontSize: 30,
            lineHeight: 1.42,
            color: DIM,
            maxWidth: 720,
          }}
        >
          Launch a token on a bonding curve. Graduate to a real pool with the
          liquidity burned.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          paddingTop: 24,
          borderTop: `1px solid ${HAIR}`,
        }}
      >
        <Datum label="On the curve" value={fmtTokens(CURVE.curveSupply)} />
        <Datum label="Graduates at" value={`${fmtEth(CURVE.graduationEth)} ETH`} />
        <Datum label="Then" value="LP burned" gold />
        <Datum label="Pool fee" value="0.30%" />
      </div>
    </Scene>
  );
}
