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
 * The site's share card.
 *
 * Every link to underwater.fun used to unfurl bare — a title, a line of
 * description, and whatever grey rectangle the client draws when there is no
 * image. This is the poster instead, and it is the wordmark and the depth scene
 * because those are the two things the brand actually is.
 *
 * The strip along the bottom is the curve's real constants, read from
 * lib/contracts.ts rather than typed out. Not decoration: the one thing worth
 * saying to somebody who has never seen the site is what the mechanism is, and
 * "800M on the curve, graduates at 4 ETH, LP burned" is that in nine words. It
 * also cannot go stale — if the contract's constants change, so does the card.
 *
 * No `revalidate` here on purpose. Nothing in it depends on chain state, so Next
 * renders it once at build and serves it as a static asset forever.
 */

export const alt = "underwater.fun — a meme launchpad on Ink";
export const size = CARD;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <Scene t={0.12}>
        <Rubric right="Meme launchpad · Ink" />

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
    ),
    { ...size, fonts: await brandFonts() },
  );
}
