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
import { PLATES } from "@/lib/contracts";

/**
 * The waterdrop's share card — the allowlist registration.
 *
 * It used to be one of two cards on `/`, chosen by whether the pre-launch gate was
 * up: while the gate was up the registration was the only thing anybody could
 * reach, so the bare domain had to unfurl as this. Now that the app is open the
 * registration is one route among several and it has its own poster, on the URL
 * that is actually shared for it. Its title and description are beside it in
 * ./layout.tsx, so the words under the card and the card itself cannot disagree.
 *
 * Deeper water than the launchpad card at `t=0.06`: the scene's depth is a
 * curve's progress toward graduation everywhere else in this codebase, and the
 * waterdrop happens before anything has launched at all, so this is the darkest
 * the card ever gets. It gets lighter, once, and then never again.
 *
 * Nothing here reads the chain — only constants from this repo — which is what
 * lets Next render it once at build and serve it as a static asset forever. It is
 * also why the card does not claim the window is open. A poster lives in a
 * timeline long after the window shuts, and a build-time "OPEN NOW" would
 * eventually be a lie told in our own typeface. So the badge says what this is,
 * not when it is.
 *
 * `2,000 of 2,222` is the fact that does the work: almost the entire collection
 * goes through the allowlist, which is the argument for registering and is two
 * constants rather than a boast. The counts are formatted `en-US` explicitly — a
 * bigint's `toLocaleString` follows the *builder's* locale, and a card baked in a
 * machine set to de-DE would print "2.000" as our headline number.
 *
 * "Gas only" rather than a chain name in the last slot: the waitlist is on Sepolia
 * now and mainnet at launch, and a poster cannot be re-cut per network — so the
 * chain goes in the rubric as the brand word and the slot says something that
 * cannot expire instead. Both entrypoints are `nonpayable` and the panel sends no
 * value, so registering costs gas and nothing else, forever. It is also the first
 * question anybody asks about an allowlist.
 *
 * The subtitle says registering puts a wallet *in* the waterdrop, and not that it
 * puts one on the allowlist, because those are different things and the difference
 * is the one this project cannot get wrong. Registration is intake: the allowlist
 * is a Merkle tree drawn from the registrants afterward, under criteria published
 * before the window opened, and a wallet that registers can still miss the cut.
 * ./page.tsx carries that sentence in full and WaitlistPanel's docblock says why —
 * overpromising is the one thing the interface can do that the contract cannot
 * undo. A poster is the worst place to do it: it is seen by the most people, read
 * by the fewest carefully, and it has no surrounding page to qualify it.
 */

export const alt = "underwater.fun — register your wallet in the waterdrop";
export const size = CARD;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<Waterdrop />, {
    ...size,
    fonts: await brandFonts(),
  });
}

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
          One transaction puts your wallet in the waterdrop — no form, and no
          email. The plates allowlist is drawn from everyone who registers, under
          criteria published up front.
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
