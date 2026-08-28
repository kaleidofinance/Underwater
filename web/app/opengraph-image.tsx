import { ImageResponse } from "next/og";
import {
  Badge,
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
import { CURVE, PLATES } from "@/lib/contracts";
import { fmtEth, fmtTokens } from "@/lib/format";
import { GATE_ON } from "@/lib/gate";

/**
 * The site's share card — the waterdrop's, or the launchpad's.
 *
 * Every link to underwater.fun used to unfurl bare: a title, a line of
 * description, and whatever grey rectangle the client draws when there is no
 * image. This is the poster instead, and it is the wordmark and the depth scene
 * because those are the two things the brand actually is.
 *
 * Which poster follows the gate, off the one flag, and that is the point of doing
 * it here rather than in a card of its own under /waterdrop. While the gate is up
 * the only thing anybody can reach is the registration form, and the URL they were
 * sent is the bare domain — Next inherits this card down to every route that has
 * not defined one, so `/` is what unfurls in the timeline. A separate
 * `/waterdrop` card would be the right poster on the one link nobody is sharing.
 * Tying both to `GATE_ON` also means the announcement and the artwork cannot
 * disagree: one env var and a redeploy moves them together.
 *
 * Both cards say only things that are constants in this repo — the curve's
 * supply and graduation, the collection's two counts. Nothing here reads the
 * chain, which is what lets Next render it once at build and serve it as a static
 * asset forever, and it is also why neither card claims the registration window is
 * open. A poster lives in a timeline long after the window shuts, and a build-time
 * "OPEN NOW" would eventually be a lie told in our own typeface.
 */

export const alt = GATE_ON
  ? "underwater.fun — register for the plates allowlist"
  : "underwater.fun — a meme launchpad on InkChain";
export const size = CARD;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(GATE_ON ? <Waterdrop /> : <Launchpad />, {
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

/**
 * The waterdrop — the allowlist registration, which is the whole of the site
 * while the gate is up.
 *
 * Deeper water than the launchpad card at `t=0.06`: the scene's depth is a
 * curve's progress toward graduation everywhere else in this codebase, and the
 * waterdrop happens before anything has launched at all, so this is the darkest
 * the card ever gets. It gets lighter, once, and then never again.
 *
 * The badge says what this is, not when it is, for the reason at the top of the
 * file. `2,000 of 2,222` is the fact that does the work: almost the entire
 * collection goes through the allowlist, which is the argument for registering and
 * is two constants rather than a boast. The counts are formatted `en-US`
 * explicitly — a bigint's `toLocaleString` follows the *builder's* locale, and a
 * card baked in a machine set to de-DE would print "2.000" as our headline number.
 *
 * "Gas only" rather than a chain name in the last slot. It was `Chain · Ink`,
 * which is the bare network name #12 got rid of, and neither replacement is
 * available to a poster: the waitlist is on Sepolia now and mainnet at launch, and
 * nothing about `GATE_ON` moves with it — so the chain goes in the rubric as the
 * brand word and the slot says something that cannot expire instead. Both
 * entrypoints are `nonpayable` and the panel sends no value, so registering costs
 * gas and nothing else, forever. It is also the first question anybody asks about
 * an allowlist.
 */
function Waterdrop() {
  return (
    <Scene t={0.06}>
      <Rubric right="Allowlist registration · InkChain" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "flex-start",
          gap: 24,
        }}
      >
        <Badge gold>the waterdrop</Badge>

        <Wordmark size={118} />

        <div
          style={{
            display: "flex",
            fontFamily: FONT.serif,
            fontWeight: 300,
            fontSize: 30,
            lineHeight: 1.42,
            color: DIM,
            maxWidth: 760,
          }}
        >
          Register for the plates allowlist. One transaction, from the wallet you
          want on the list — there is no form, and no email.
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
        <Datum
          label="Allowlist plates"
          value={PLATES.wlAllocation.toLocaleString("en-US")}
          gold
        />
        <Datum
          label="Of a collection of"
          value={PLATES.supply.toLocaleString("en-US")}
        />
        <Datum label="To register" value="One tx" />
        <Datum label="Costs" value="Gas only" />
      </div>
    </Scene>
  );
}
