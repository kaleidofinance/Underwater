import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Masthead } from "@/components/Chrome";
import { REPO_URL, SECURITY_URL } from "@/lib/links";

/**
 * /docs — how the thing works, for the person using it.
 *
 * A **server component**, and that is the whole design decision. Every other page
 * here is `"use client"` because it reads a chain; this one reads nothing, so it
 * ships as static HTML that a crawler, a reader with JavaScript off, and a
 * reviewer looking for who runs this site all get on the first byte. The masthead
 * is the one client island in it, imported across the boundary the way Next
 * intends.
 *
 * One route rather than a tree of them. A documentation site is a reading order,
 * and a handful of sections that each fit on a screen read better as one scroll
 * with a contents rail than as a handful of navigations — and there is no routing,
 * no generateStaticParams and no per-page metadata to keep in sync. If a section
 * outgrows the page it can be promoted to `/docs/<id>` later; the ids below are
 * already the URLs it would take.
 *
 * **Scope: no source code, and no walkthrough of the contracts.** This page is
 * what a user needs — what the product does, what a trade costs, what the numbers
 * are and what can go wrong. Contract names, function names, constant names and
 * addresses are deliberately absent: they date faster than anything else here,
 * they are the wrong register for the audience, and the repository already
 * documents itself for the reader who wants that. Deployed addresses live in
 * SECURITY.md for the same reason — one list a scanner and a reader both arrive
 * at, rather than a copy here that can go stale.
 *
 * What stays is the arithmetic. "The math is published before you buy" is the
 * pitch, so the curve, the graduation threshold and the fee ceilings are stated
 * outright; every figure was checked against the source before it was written.
 *
 * Four figures, and each one is drawn the only way it can be. The curve chart is
 * inline SVG and the lifecycle strip is flexbox, both painted from the design
 * tokens, because the site follows the OS between two themes and an exported PNG
 * cannot — a light-mode reader would get a dark chart with an invisible hairline.
 * The plates are the exception and go the other way: they are `<img>` tags over
 * real renderer output in /public/art, they keep their own field — cream while the
 * position holds, near black once it drowns — instead of the page's, and they have
 * to, because that is the artwork the contract emits rather than a diagram about
 * it. Markup is not JavaScript, so the page is still static at 186 B; see the
 * /docs figures block at the end of globals.css for the geometry notes and the
 * reason the plates are images and not inline SVG.
 *
 * The one claim this page deliberately does not make is a fairness promise about
 * the reveal. See the plates bullet under Risks: it says what the draw is and who
 * can make it, which is true, instead of a guarantee nothing enforces.
 *
 * One absence is named outright rather than left to be discovered, because a
 * reader looking for it will otherwise assume it exists and is being hidden.
 * Under Fees: the four fees are the whole revenue model, and a creator earns
 * nothing from their own token's trading.
 *
 * Under Rewards the job is the reverse. uwPoints exist, so the section states the
 * rate card and says where a balance comes from; every figure is quoted from
 * lib/points.ts and checked against the contract behind it. The two claims worth
 * making there are the ones no number on the page can show — that no balance is
 * stored, and that changing a rate re-prices history rather than grandfathering
 * it. Both are properties of the arithmetic rather than promises about our
 * conduct, which is the only reason they belong on a page that refuses to promise
 * the reveal is fair.
 *
 * Networks is the section staleness costs the most, because it is the one a reader
 * checks a claim against. It names four chains across two families and says which
 * one the app opens on, and it states the asymmetry outright rather than leaving it
 * to be inferred: the collection and the waterdrop cannot exist on Robinhood, so
 * the default network carries three of the five products and not all five. Two
 * other places have to agree with it or the page contradicts itself — the status
 * panel under Overview, and the Roadmap, which names mainnet rather than one
 * chain's mainnet and can no longer call Robinhood Chain the network the app opens
 * on, because the default is now its testnet. The launch walkthrough under Usage
 * used to be a third: it said *switch*, which was true only while the default was
 * a network nobody could launch on.
 */

export const metadata: Metadata = {
  title: "Docs — underwater.fun",
  description:
    "How underwater.fun works: the bonding curve, graduation into a pool with burned liquidity, the plates collection, every fee and who collects it, how uwPoints are counted, what $WATER will be, and what is not built yet.",
  openGraph: {
    title: "Docs — underwater.fun",
    description:
      "The curve, graduation, the plates, every fee and its ceiling, how the protocol earns, and the part that is not finished.",
    url: "/docs",
  },
};

/**
 * The contents rail and the section headers come from one array, so the two
 * cannot drift — a nav row that scrolls to nothing is the classic docs bug, and
 * the only way to write one here is to add an entry and no section. `Section`
 * takes its id from this union, so the reverse (a section the rail does not list)
 * is a type error rather than a page nobody can find.
 */
const SECTIONS = [
  { id: "overview", label: "Overview", kicker: "what this is" },
  { id: "products", label: "Products", kicker: "five of them" },
  { id: "curve", label: "The curve", kicker: "price ∝ (1 + eth)²" },
  { id: "usage", label: "Usage", kicker: "start to finish" },
  { id: "fees", label: "Fees", kicker: "four, and where they go" },
  { id: "tokens", label: "Tokens", kicker: "launches, and plates" },
  { id: "rewards", label: "Rewards", kicker: "$water, and what counts" },
  { id: "network", label: "Networks", kicker: "four, in two families" },
  { id: "roadmap", label: "Roadmap", kicker: "in order, without dates" },
  { id: "risks", label: "Risks", kicker: "the unflattering part" },
  { id: "links", label: "Links", kicker: "everything else" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const KICKERS = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.kicker]),
) as Record<SectionId, string>;

const LABELS = Object.fromEntries(
  SECTIONS.map((s) => [s.id, s.label]),
) as Record<SectionId, string>;

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section id={id} className="doc-sec">
      <div className="sec">
        <h2>{LABELS[id]}</h2>
        <span>{KICKERS[id]}</span>
      </div>
      {children}
    </section>
  );
}

/** A named thing with a route and a sentence. The products list and nothing else. */
function Product({
  name,
  href,
  external,
  children,
}: {
  name: string;
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="doc-prod">
      <div className="doc-prod-head">
        {external ? (
          <a href={href} target="_blank" rel="noreferrer">
            {name} ↗
          </a>
        ) : (
          <Link href={href}>{name}</Link>
        )}
        <span className="dim">{external ? "off site" : href}</span>
      </div>
      <p className="note">{children}</p>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="shell docs">
      <Masthead />

      <header className="doc-masthead">
        <h1 className="title">Documentation</h1>
        <p className="note doc-lede">
          A launchpad on InkChain where the math is published before you buy.
          This page is the whole thing in one scroll: the curve a token sells on,
          what graduation does to the liquidity, the plates collection that reads
          a lending position, every fee with the ceiling it cannot pass and who
          collects it, what $WATER will and will not be, and the list of things
          that are not finished. The code is{" "}
          <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
            public
          </a>
          , and every number below was checked against it.
        </p>
      </header>

      <div className="stage doc-stage">
        <div className="doc-main">
          <Section id="overview">
            <p className="note">
              <b>underwater.fun</b> lets anyone create a token in one transaction
              and sell it on a bonding curve whose formula is fixed and public.
              There is no presale, no team allocation and no allowlist on the
              curve — being early to the curve is the only discount, and it is the
              same curve for every token.
            </p>
            <p className="note">
              At <b>4 ETH raised</b> the curve closes itself. The ETH and the
              200M tokens held back from the sale go into a real
              Uniswap-V2-style pool, and the liquidity is{" "}
              <b>burned to a dead address</b>. Not locked, not vested — burned.
              There is no key, no timelock and no multisig, because after
              graduation there is nobody left who could move that liquidity,
              including us.
            </p>
            <p className="note">
              Alongside the launchpad is{" "}
              <Link className="link" href="/plates">
                Underwater Plates
              </Link>
              , a 2222-piece collection drawn entirely on chain, where a plate
              that is pointed at a leveraged Aave position dissolves as that
              position&apos;s health factor falls — and can be burned by a
              stranger when it liquidates.
            </p>

            <div className="panel doc-status">
              <div className="panel-head">
                <span>Status</span>
                <span className="dim">checkable</span>
              </div>
              <dl>
                <div className="r-row">
                  <dt>Live on</dt>
                  <dd>Ink Sepolia · Robinhood Testnet</dd>
                </div>
                <div className="r-row">
                  <dt>Mainnet</dt>
                  <dd className="dim">neither, yet</dd>
                </div>
                <div className="r-row">
                  <dt>Audit</dt>
                  <dd className="warn">none</dd>
                </div>
                <div className="r-row">
                  <dt>Test suite</dt>
                  <dd>354 passing, 0 skipped</dd>
                </div>
                <div className="r-row">
                  <dt>Source</dt>
                  <dd>
                    <a
                      className="link"
                      href={REPO_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      kaleidofinance/Underwater ↗
                    </a>
                  </dd>
                </div>
              </dl>
              <p className="field-note">
                We are on testnets and validating in public before mainnet.
                Launching real money is not open yet.
              </p>
            </div>
          </Section>

          <Section id="products">
            <p className="note">
              Five things, each with its own page in the app.
            </p>

            <Product name="Launchpad" href="/create">
              Create a token, then buy and sell it on the curve. Creation and the
              creator&apos;s first buy are the same transaction, so a launch
              cannot be sniped between the two. The{" "}
              <Link className="link" href="/">
                market
              </Link>{" "}
              lists every launch with its curve progress; a token&apos;s own page
              carries the chart, the trade panel and the trade history.
            </Product>

            <Product name="DEX" href="/swap">
              Our own Uniswap-V2-style exchange, which is where a graduated token
              trades. It exists because a graduation needs a pool to land in and
              neither testnet has an exchange to supply one — the addresses
              labelled Uniswap V3 on Robinhood are proxies with nothing behind
              them — so without ours the launchpad could not run end to end
              anywhere. Swaps are ETH↔token.
            </Product>

            <Product name="Underwater Plates" href="/plates">
              2222 hydrographic survey plates, drawn on chain rather than hosted
              anywhere. Attach an Aave position and the drawing reads it: crisp
              in dry dock, dissolving into ink plumes as the health factor falls,
              burnable by anyone once it liquidates.
            </Product>

            <Product name="The waterdrop" href="/waterdrop">
              Allowlist intake for the plates mint. One transaction registers a
              wallet — no form, no email, and a registration is only ever
              accepted from the wallet being registered. Registration is intake,
              not entitlement: the allowlist is drawn from the registrants under
              criteria published before anyone could register.
            </Product>

            <Product name="Profile" href="/profile">
              One wallet&apos;s own view — the launches it created, the positions
              it holds, and what a $WATER distribution would draw on. Nothing
              there is claimable yet.
            </Product>
          </Section>

          <Section id="curve">
            <p className="note">
              A launch mints <b>1,000,000,000</b> tokens. <b>800M</b> are sold on
              the curve and <b>200M</b> are held back for the pool. The curve is a
              constant product against a <b>virtual 1 ETH reserve</b> — virtual
              because nobody deposited it; it exists to give the first buyer a
              price instead of a division by zero.
            </p>

            <div className="doc-eq">
              <span>x · y = k</span>
              <span>
                x<sub>0</sub> = 1 ETH (virtual) · y<sub>0</sub> = 1,000,000,000
              </span>
              <span>
                raise(S) = x<sub>0</sub> · S / (y<sub>0</sub> − S)
              </span>
            </div>

            <p className="note">
              Put the 800M curve supply through that and the answer is the
              graduation threshold:{" "}
              <code>1 ETH × 800M / 200M = 4 ETH</code>. So 4 ETH is not a number
              somebody picked — it is the exact raise that empties the curve
              supply, which is why graduation and sell-out are the same event.
            </p>

            <p className="note">
              Price is quadratic in the raise, so the multiple from launch to
              graduation is an identity rather than a target:
            </p>

            <div className="doc-eq">
              <span>
                (1 + 4)² ÷ (1 + 0)² = <b>25×</b>, exactly, every time
              </span>
              <span className="dim">1 gwei → 25 gwei · FDV 1 ETH → 25 ETH</span>
            </div>

            {/* The same formula, drawn — because the two .doc-eq blocks above are
                worth nothing to a reader who does not read formulas, and the
                shape carries a fact the arithmetic hides: the gain is not spread
                evenly along the curve.

                One quadratic Bézier, and that is exact rather than a fitted
                approximation. A degree-2 Bézier *is* a parabola, and price is
                exactly quadratic in the raise, so putting the control point where
                the two end tangents meet reproduces the curve to the pixel. Its
                midpoint lands on (2 ETH, 9×), which is the annotated point.

                Labels are short tokens only — 1×, 9×, 25×. Everything that needs
                a sentence is in the figcaption instead, as real HTML text at a
                real font size, because SVG text scales with the viewBox and this
                one is downscaled to about 0.73 on a 375px phone. */}
            <figure className="doc-fig">
              <svg
                className="doc-fig-curve"
                viewBox="0 0 460 280"
                role="img"
                aria-label="Price plotted against ETH raised. It starts at 1× and curves upward, passing 9× at 2 ETH raised and reaching 25× at the 4 ETH graduation point."
              >
                <g className="guide">
                  <line x1="48" y1="30" x2="354" y2="30" />
                  <line x1="48" y1="167.3" x2="201" y2="167.3" />
                  <line x1="201" y1="167.3" x2="201" y2="236" />
                  <line x1="354" y1="30" x2="354" y2="236" />
                </g>
                <path
                  className="area"
                  d="M48 236 Q201 201.667 354 30 L354 236 Z"
                />
                <path className="curve" d="M48 236 Q201 201.667 354 30" />
                <g className="axis">
                  <line x1="48" y1="236" x2="392" y2="236" />
                  <line x1="48" y1="22" x2="48" y2="236" />
                </g>
                <circle className="dot" cx="201" cy="167.3" r="3" />
                <circle className="dot grad" cx="354" cy="30" r="4.5" />
                <g className="tick">
                  <text x="40" y="34" textAnchor="end">
                    25×
                  </text>
                  <text x="40" y="171" textAnchor="end">
                    9×
                  </text>
                  <text x="40" y="240" textAnchor="end">
                    1×
                  </text>
                  <text x="48" y="257" textAnchor="middle">
                    0
                  </text>
                  <text x="201" y="257" textAnchor="middle">
                    2
                  </text>
                  <text x="354" y="257" textAnchor="middle">
                    4 ETH
                  </text>
                </g>
                <text className="mark" x="364" y="34">
                  graduates
                </text>
              </svg>
              <figcaption className="field-note">
                Price against ETH raised, drawn from the formula above rather than
                sketched. The shape is the part the arithmetic hides: at{" "}
                <b>2 ETH</b> — half the raise — a token is at <b>9×</b>, not
                12.5×. Two thirds of the whole 25× arrives in the second half of
                the curve. That is what being early is worth here, and it is worth
                exactly that and no more.
              </figcaption>
            </figure>

            <p className="note">
              Two properties worth knowing because they cost you something.{" "}
              <b>Rounding always favours the pool</b> — buys round tokens out
              down, sells round ETH out down — so splitting a buy into ten never
              beats making it once, and a round trip never profits. Both are
              checked over 10,000 randomised runs. And a curve that never reaches
              4 ETH simply stays a curve: it does not expire, refund, or graduate
              on a timer.
            </p>
          </Section>

          <Section id="usage">
            {/* The four subsections below in one line, as the map for them.
                Built in CSS rather than SVG on purpose: a four-across strip has
                to become a four-down list on a phone, and an SVG would only
                scale — 11px labels at 0.7 are unreadable. Flexbox reflows, and
                the arrow flips from → to ↓ with it. */}
            <div className="doc-flow">
              <div className="doc-flow-step">
                <b>Create</b>
                <span>one transaction</span>
              </div>
              <div className="doc-flow-step">
                <b>Curve</b>
                <span>1% per trade</span>
              </div>
              <div className="doc-flow-step">
                <b>4 ETH</b>
                <span>closes itself</span>
              </div>
              <div className="doc-flow-step">
                <b>Pool</b>
                <span>liquidity burned</span>
              </div>
            </div>

            <h3 className="doc-h">Launch a token</h3>
            <ol className="doc-steps">
              <li>
                Connect a wallet on{" "}
                <Link className="link" href="/create">
                  /create
                </Link>
                . The app opens on Robinhood Testnet, which is live, so there is
                nothing to switch unless you want Ink Sepolia instead.
              </li>
              <li>
                Give it a name, a symbol and an image. The app handles hosting
                the image for you.
              </li>
              <li>
                Optionally attach a first buy. It settles in the{" "}
                <b>same transaction</b> as the creation, which is what makes the
                creator&apos;s own entry unsnipeable.
              </li>
              <li>
                Send it. The token, the curve and the market listing all exist at
                that block.
              </li>
            </ol>

            <h3 className="doc-h">Trade the curve</h3>
            <ol className="doc-steps">
              <li>
                Open the token from the{" "}
                <Link className="link" href="/">
                  market
                </Link>
                . The depth bar is curve progress toward 4 ETH.
              </li>
              <li>
                Buy with ETH or sell tokens back. The quote is the curve
                evaluated at the current reserves — no order book, no
                counterparty, and no way to be filled at a different price than
                the one the formula gives at your block.
              </li>
              <li>
                A <b>1% fee</b> applies to each trade, taken in ETH. It is
                settable, and it cannot exceed 2%.
              </li>
            </ol>

            <h3 className="doc-h">Graduation</h3>
            <p className="note">
              Automatic. The buy that carries the raise to 4 ETH is{" "}
              <b>sized down to land exactly on it</b> and the excess ETH is
              refunded in the same transaction, so nobody overshoots and nobody
              pays for tokens the curve no longer has. Then, still in that
              transaction:
            </p>
            <ol className="doc-steps">
              <li>The graduation fee is taken from the 4 ETH — 5%, capped at 10%.</li>
              <li>The remaining ETH and the held-back 200M create the pool.</li>
              <li>The liquidity from that deposit is burned.</li>
              <li>
                Any curve tokens still unsold after the size-down are burned, so
                the circulating supply matches what was actually bought.
              </li>
            </ol>

            <h3 className="doc-h">Swap a graduated token</h3>
            <ol className="doc-steps">
              <li>
                Go to{" "}
                <Link className="link" href="/swap">
                  /swap
                </Link>
                , or use the swap panel on the token&apos;s own page.
              </li>
              <li>Pick a direction. Pairs are ETH↔token.</li>
              <li>
                <b>0.30%</b> of each swap is the pool fee. 0.25% stays with
                liquidity providers; 0.05% is the protocol&apos;s cut.
              </li>
            </ol>

            <h3 className="doc-h">Mint a plate</h3>
            <ol className="doc-steps">
              <li>
                Register on{" "}
                <Link className="link" href="/waterdrop">
                  /waterdrop
                </Link>{" "}
                while the window is open. One transaction, from the wallet itself.
              </li>
              <li>
                If the allowlist includes you, the app proves your place for you.
                Whatever the allowlist phase does not take rolls into the public
                phase.
              </li>
              <li>
                Mint on{" "}
                <Link className="link" href="/mint">
                  /mint
                </Link>
                . What you receive is a sealed survey tube — the same drawing for
                every plate, stamped with its own number and nothing else.
              </li>
              <li>
                After minting closes, the reveal draws the offset that maps plate
                numbers onto the sealed trait list, and the art appears.
              </li>
            </ol>

            {/* The tube, beside the steps rather than in them, because it is the
                one thing on this page a reader can be shown instead of told: the
                step above says every plate arrives as the same drawing, and this
                is that drawing. Same renderer as the four states under Tokens. */}
            <figure className="doc-fig doc-fig-inline">
              <img
                className="doc-plate-single"
                src="/art/plate-sealed.svg"
                alt="A sealed survey tube drawn in brown on cream: a capped cylinder with a wax seal at its middle, stamped No. 0006 of 2222 and SEALED, carrying no traits."
                width={400}
                height={620}
                loading="lazy"
              />
              <figcaption className="field-note">
                What arrives at mint. Every plate is this drawing, differing only
                in the number stamped at the bottom — there is no trait on it to
                grade, because the plate-to-slot offset does not exist yet.
              </figcaption>
            </figure>

            <h3 className="doc-h">Attach a position</h3>
            <p className="note">
              Optional, and the one decision on this page that can lose you the
              token. Point a plate at an address with an Aave position and the
              drawing starts reading that position on every view — the plate
              dissolves as the health factor falls, can be engraved with a scar
              below 1.4, and at 1.0 anyone may drown it: burn it, and mint
              themselves a trophy. A plate with nothing attached cannot be drowned
              by anybody. See{" "}
              <a className="link" href="#risks">
                Risks
              </a>
              .
            </p>
          </Section>

          <Section id="fees">
            <p className="note">
              There are <b>four</b>, and this is the complete list. Three belong
              to the launchpad and are settable by its owner within hard ceilings
              that cannot themselves be raised; the fourth belongs to the DEX and
              only starts applying after a token graduates. If you find a fifth,
              it is a bug and we want the report.
            </p>

            {/* `data-label` on every cell but the first is what the header row
                becomes on a phone: below 640px globals.css stacks each row into a
                labelled block and hides <thead>, because the last column here is a
                sentence and a scrolling table takes the row's own subject off
                screen while you read it. .doc-table-note marks that last-column-is-
                prose shape; the network table below does not have it. */}
            <div className="doc-table-wrap">
              <table className="doc-table doc-table-note">
                <thead>
                  <tr>
                    <th>Fee</th>
                    <th>Now</th>
                    <th>Hard cap</th>
                    <th>Where</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Trade, buy and sell</td>
                    <td data-label="Now">1%</td>
                    <td data-label="Hard cap">2%</td>
                    <td className="dim" data-label="Where">
                      on the curve
                    </td>
                  </tr>
                  <tr>
                    <td>Token creation</td>
                    <td data-label="Now">0</td>
                    <td data-label="Hard cap">0.01 ETH</td>
                    <td className="dim" data-label="Where">
                      once, at launch
                    </td>
                  </tr>
                  <tr>
                    <td>Graduation, of the 4 ETH</td>
                    <td data-label="Now">5%</td>
                    <td data-label="Hard cap">10%</td>
                    <td className="dim" data-label="Where">
                      once, at graduation
                    </td>
                  </tr>
                  <tr>
                    <td>Pool swap</td>
                    <td data-label="Now">0.30%</td>
                    <td className="dim" data-label="Hard cap">
                      fixed
                    </td>
                    <td className="dim" data-label="Where">
                      after graduation
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="note">
              The ceilings are the part worth checking. A settable fee with no
              ceiling is a promise; a settable fee under a ceiling that nobody can
              raise is a bounded parameter, and the bound holds whatever we
              intend.
            </p>

            <p className="note">
              The pool fee is not settable at all — <b>0.30%</b> is fixed. What is
              switchable is the protocol&apos;s share of it, which works out to{" "}
              <b>0.05% of swap volume</b>, and it is switched on for our deploy.
            </p>

            <p className="note">
              Two more fees exist on the plates rather than the launchpad. The{" "}
              <b>mint price</b> is owner-settable under a <b>1 ETH ceiling</b>,
              because it targets a dollar figure while ETH moves.{" "}
              <b>Secondary royalty is 5%</b>, fixed, and reported through the
              standard royalty interface so marketplaces can read it.
            </p>

            <h3 className="doc-h">Where the money goes</h3>
            <p className="note">
              <b>Every fee above is the protocol&apos;s revenue, and there is no
              other.</b> No subscription, no listing fee, no paid promotion on the
              market page, no spread added to a quote, and nothing taken from a
              wallet for holding or transferring. If we ever earn from this it is
              because tokens were created, traded and graduated — which is the
              only revenue model we want, because it cannot pay unless the thing
              works.
            </p>
            <p className="note">
              <b>A creator earns nothing from their own token&apos;s trading.</b>{" "}
              Some launchpads route a slice of every trade back to whoever
              launched it; ours does not, and that is deliberate rather than
              unbuilt. A per-launch revenue share is a standing reason to spam
              launches, and the incentive we would rather create is to launch
              something people want to hold. What a creator gets instead is the
              curve: they can buy their own launch first, in the same transaction
              that creates it, at the lowest price it will ever have.
            </p>
            <p className="note">
              Three of the four arrive as ETH the moment they are charged. The
              pool&apos;s 0.05% is the exception — it accrues inside each
              graduated pool and has to be settled before it is anything, which is
              covered under{" "}
              <a className="link" href="#risks">
                Risks
              </a>
              . Whoever deployed the launchpad can read the running total on{" "}
              <Link className="link" href="/profile">
                /profile
              </Link>
              ; nobody else sees that tab, and it is a readout rather than a
              button.
            </p>
          </Section>

          <Section id="tokens">
            <h3 className="doc-h">A launch token</h3>
            <p className="note">
              Standard ERC-20, 18 decimals. Fixed supply per launch, and nothing
              can mint more of it afterwards:
            </p>
            <div className="doc-table-wrap">
              <table className="doc-table doc-table-note">
                <thead>
                  <tr>
                    <th>Allocation</th>
                    <th>Amount</th>
                    <th>Share</th>
                    <th>Fate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Sold on the curve</td>
                    <td data-label="Amount">800,000,000</td>
                    <td data-label="Share">80%</td>
                    <td className="dim" data-label="Fate">
                      to buyers; unsold remainder burned
                    </td>
                  </tr>
                  <tr>
                    <td>Held for the pool</td>
                    <td data-label="Amount">200,000,000</td>
                    <td data-label="Share">20%</td>
                    <td className="dim" data-label="Fate">
                      paired with the raise; liquidity burned
                    </td>
                  </tr>
                  <tr>
                    <td>Team, presale, advisors</td>
                    <td data-label="Amount">0</td>
                    <td data-label="Share">0%</td>
                    <td className="dim" data-label="Fate">
                      there is no allocation
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className="doc-h">Underwater Plates</h3>
            <p className="note">
              ERC-721, <b>2222</b> in total and capped there. The allowlist phase
              is allocated 2000 and the public phase takes whatever it does not
              use. Per-wallet limits are settable under a ceiling of 222. Royalty
              is 5%. Nothing is hosted anywhere: both the artwork and its
              metadata are built on chain, at the moment they are asked for.
            </p>

            {/* One plate, four states, so the dissolve reads as a progression
                rather than as an adjective. These are the real renderer's output,
                not mockups: `python art/render.py --showcase` writes them to
                art/showcase/*.svg and web/public/art/ carries a copy, because
                Next only serves public/ and art/showcase/ is where the
                reproducible original lives.

                <img> rather than inline SVG, and that is forced rather than
                preferred: all seven state files are the same plate, so they all
                namespace their gradients and filters under `p6`. Inline two of
                them in one document and the second answers to the first one's
                <defs>. Separate documents keep the namespaces apart. */}
            <figure className="doc-fig">
              <ol className="doc-plates">
                <li className="doc-plate">
                  <img
                    src="/art/plate-dry.svg"
                    alt="A survey plate on cream paper, every line crisp and fully legible."
                    width={400}
                    height={620}
                    loading="lazy"
                  />
                  <b>Dry dock</b>
                  <span>nothing attached</span>
                </li>
                <li className="doc-plate">
                  <img
                    src="/art/plate-twilight.svg"
                    alt="The same plate with its lines smeared and softened, a faint ink ghost of the drawing showing behind them."
                    width={400}
                    height={620}
                    loading="lazy"
                  />
                  <b>Twilight</b>
                  <span>health factor 1.90</span>
                </li>
                <li className="doc-plate">
                  <img
                    src="/art/plate-crush.svg"
                    alt="The same plate far further gone, its lines dragged out into ink plumes, with three faint ringed marks across the paper."
                    width={400}
                    height={620}
                    loading="lazy"
                  />
                  <b>Crush depth</b>
                  <span>1.05, three scars</span>
                </li>
                <li className="doc-plate">
                  <img
                    src="/art/plate-drowned.svg"
                    alt="A near-black field with the drawing gone entirely, stamped DROWNED."
                    width={400}
                    height={620}
                    loading="lazy"
                  />
                  <b>Drowned</b>
                  <span>1.00 — anyone may burn it</span>
                </li>
              </ol>
              <figcaption className="field-note">
                The same plate — number 6 — at four states of the position behind
                it. A plate with nothing attached stays in dry dock permanently;
                the other three are what attaching one can do. The scars in the
                third are not damage from that moment: they count the near-death
                dips the position already survived, up to eight. The fourth is not
                a state a plate sits in for long: at 1.00 anyone at all may burn
                it, and the trophy they mint for doing so is the point of it.
              </figcaption>
            </figure>
          </Section>

          <Section id="rewards">
            <h3 className="doc-h">$WATER</h3>
            <p className="note">
              <b>$WATER is coming, and it does not exist yet.</b> There is no
              contract, no address, no sale, no allocation table, no date and
              nothing to claim. It is a protocol token planned to be shared with
              the people who make the market: token <b>creators</b>,{" "}
              <b>liquidity providers</b> and <b>traders</b>. Anything you find
              elsewhere offering to sell you one is not us — the{" "}
              <a
                className="link"
                href={SECURITY_URL}
                target="_blank"
                rel="noreferrer"
              >
                security policy
              </a>{" "}
              lists every account and domain that is.
            </p>

            <h3 className="doc-h">uwPoints</h3>
            <p className="note">
              Four things earn <b>uwPoints</b>: registering for the waterdrop
              (<b>10,000</b>, once), a referral that clears the activity bar
              (<b>1,000</b> each), launching a token (<b>20,000</b> each), and a
              trade, on a curve or in a pool (<b>10</b> each). A coupon code or a
              hand grant can add to a balance. Nothing subtracts from one — there
              is nothing to spend points on, so there is no way to lose them
              either.
            </p>
            <p className="note">
              The <b>activity bar</b> on a referral is the same one the waterdrop
              uses: the referred wallet needs at least <b>ten transactions</b> on
              Ink, mainnet or Sepolia. Referrals short of it are shown and pay
              nothing, so the count you see is every registration through your
              link and the number that pays is the subset above the bar. It is
              there because a referral rate with no bar pays for wallets made to
              collect it.
            </p>
            <p className="note">
              <b>No balance is stored anywhere.</b> It is the rate card multiplied
              by counts of on-chain events, plus whatever has been granted,
              recomputed from the logs on every read. So there is no database
              behind it: you do not register, sign anything or keep a tab open for
              activity to count — it counted when the transaction confirmed — and
              we cannot quietly re-weight a number we never stored, or wake up one
              morning having lost everyone&apos;s history.
            </p>
            <p className="note">
              The <b>Points</b> tab on{" "}
              <Link className="link" href="/profile">
                /profile
              </Link>{" "}
              shows the total, the terms that sum to it, this wallet&apos;s rank,
              and every event each term was counted from, each row linking to the
              transaction it was read from. That list is the point of it: a balance
              nobody can check is a balance nobody has to believe.
            </p>
            <p className="note">
              What there is not: no multiplier, no season and no streak. Rates live
              in a contract, and changing one <b>re-prices history</b> rather than
              grandfathering it — the rows on that tab are priced at today&apos;s
              card, not at whatever the rate was on the day. The points contract is
              live on <b>both testnets</b> and on neither mainnet; on a network
              without it the rates shown are the launch defaults, labelled
              indicative rather than quoted as settled.
            </p>
            <p className="note">
              Alongside it is a readout in ETH, which no rate card prices. The{" "}
              <b>Rewards</b> tab on the same page shows four numbers for the
              connected wallet:
            </p>

            <div className="doc-table-wrap">
              <table className="doc-table doc-table-note">
                <thead>
                  <tr>
                    <th>Counted today</th>
                    <th>Why it is there</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Launches created</td>
                    <td className="dim" data-label="Why it is there">
                      you brought a token that did not exist before
                    </td>
                  </tr>
                  <tr>
                    <td>ETH raised across them</td>
                    <td className="dim" data-label="Why it is there">
                      separates a launch people bought from one nobody did
                    </td>
                  </tr>
                  <tr>
                    <td>Positions held</td>
                    <td className="dim" data-label="Why it is there">
                      you are holding, not only passing through
                    </td>
                  </tr>
                  <tr>
                    <td>Portfolio value</td>
                    <td className="dim" data-label="Why it is there">
                      the size of what you are holding, priced now
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="note">
              All four are read live from the chain when the page loads, the same
              way a points balance is and for the same reason.
            </p>
            <p className="note">
              <b>Liquidity provision is not counted yet.</b> It is in the plan and
              nothing prices it — not the rate card, not these four numbers — so an
              LP reading either tab today is not seeing that half of it. Trading is
              counted, but per trade at a flat rate rather than by size, so volume
              is not itself the thing that earns.
            </p>

            <div className="alert">
              None of these numbers is a promise of an allocation. There is no
              formula yet, and when there is one it will be published before it
              runs — not inferred from this page.
            </div>
          </Section>

          <Section id="network">
            <p className="note">
              Four networks, two chain families. These name actual chains — what
              a wallet has to be switched to, where a pool opens — and the app
              opens on <b>Robinhood Testnet</b>, which is what a visitor who
              never touches the switcher is reading. It opens on a testnet
              because neither mainnet is deployed yet; the day one is, that is
              the network the front door moves to.
            </p>
            <p className="note">
              &ldquo;InkChain&rdquo; is the brand word and never a claim about
              where something is deployed — a distinction that did some work when
              both chains were Ink and does all of it now. What differs between
              the families is not cosmetic: the launchpad, the exchange and
              uwPoints run on all four, but the <b>plates collection</b> and the{" "}
              <b>waterdrop</b> cannot run on Robinhood at all, because the art
              reads Aave V3 health factors and there is no Aave V3 there. On
              those two networks they are absent rather than pending — including
              on the one the app opens on.
            </p>

            {/*
              The one table on this page that reads down instead of across. Every
              other doc-table puts the subject in the first column, and this one did
              too while there were two networks; four of them side by side push the
              explorer hostnames past the width a phone has, and .doc-table's mobile
              rule reattaches headers from data-label per cell, so transposing costs
              nothing there and buys a layout where the next chain is a row rather
              than a redesign.
            */}
            <div className="doc-table-wrap">
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>&nbsp;</th>
                    <th>Chain ID</th>
                    <th>Gas token</th>
                    <th>Explorer</th>
                    <th>Our deploy</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Robinhood Chain</td>
                    <td data-label="Chain ID">4663</td>
                    <td data-label="Gas token">ETH</td>
                    <td className="dim" data-label="Explorer">
                      robinhoodchain.blockscout.com
                    </td>
                    <td className="dim" data-label="Our deploy">
                      not deployed
                    </td>
                  </tr>
                  <tr>
                    <td>Robinhood Chain Testnet</td>
                    <td data-label="Chain ID">46630</td>
                    <td data-label="Gas token">ETH</td>
                    <td className="dim" data-label="Explorer">
                      explorer.testnet.chain.robinhood.com
                    </td>
                    <td data-label="Our deploy">live</td>
                  </tr>
                  <tr>
                    <td>Ink Mainnet</td>
                    <td data-label="Chain ID">57073</td>
                    <td data-label="Gas token">ETH</td>
                    <td className="dim" data-label="Explorer">
                      explorer.inkonchain.com
                    </td>
                    <td className="dim" data-label="Our deploy">
                      not deployed
                    </td>
                  </tr>
                  <tr>
                    <td>Ink Sepolia</td>
                    <td data-label="Chain ID">763373</td>
                    <td data-label="Gas token">ETH</td>
                    <td className="dim" data-label="Explorer">
                      explorer-sepolia.inkonchain.com
                    </td>
                    <td data-label="Our deploy">live</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="field-note">
              Deployed addresses are published in{" "}
              <a
                className="link"
                href={SECURITY_URL}
                target="_blank"
                rel="noreferrer"
              >
                SECURITY.md
              </a>{" "}
              and not repeated here — one list that a scanner and a reader both
              arrive at, rather than two that can disagree. Explorer source
              verification is still outstanding, so an explorer label is not yet
              evidence of what we deployed.
            </p>
          </Section>

          <Section id="roadmap">
            <p className="note">
              In order, and deliberately without dates. A missed date is the one
              mistake on this page that cannot be walked back, so nothing here
              carries one.
            </p>
            <ol className="doc-road">
              <li>
                <b>Validate on the testnets, in public.</b> Where we are. The
                whole lifecycle runs against real chains on both:{" "}
                <b>Ink Sepolia</b> carries every surface, including the
                collection and the waitlist, and <b>Robinhood Chain Testnet</b>{" "}
                carries the three that can exist there.
              </li>
              <li>
                <b>Explorer source verification</b> for everything we deployed,
                so a reader can confirm it on the explorer rather than take our
                word for it.
              </li>
              <li>
                <b>An audit.</b> Before real money, not after it. 354 tests
                including randomised runs and tests against a live fork is not an
                audit, and running our own exchange raises the stakes rather than
                lowering them.
              </li>
              <li>
                <b>The plates drop</b>, on Ink. The waterdrop window closes, the
                allowlist is selected under the published criteria and committed
                publicly before minting opens.
              </li>
              <li>
                <b>Mainnet.</b> The same build, once testnet validation is clean
                and the audit is done. <b>Robinhood Chain</b> is the one this is
                aimed at, and the network the app will open on once it exists;{" "}
                <b>Ink Mainnet</b> is the same deploy on the chain we started on,
                and the order between them is a launch decision rather than a
                technical one — the build does not care. We will post the block
                the first curve graduates in.
              </li>
              <li>
                <b>$WATER.</b> The protocol token, to creators, liquidity
                providers and traders — and the point-counting that has to exist
                before it can be distributed. See{" "}
                <a className="link" href="#rewards">
                  Rewards
                </a>
                .
              </li>
              <li>
                <b>An indexer, and aggregator listings.</b> A token&apos;s whole
                life is already recorded on chain in a shape one indexer can read
                across both halves of it — the curve, and the pool after
                graduation.
              </li>
            </ol>
          </Section>

          <Section id="risks">
            <div className="alert">
              Not audited. Do not put money on this that you would mind losing.
            </div>

            <p className="note">
              Everything below is a known trade-off rather than a discovered bug,
              and it is here because a docs page that lists only what works is an
              advertisement.
            </p>

            <ul className="doc-list">
              <li>
                <b>No audit.</b> 354 passing tests, 10,000-run randomised
                invariants and tests against a live fork of both Ink chains. That
                is diligence, not assurance.
              </li>
              <li>
                <b>Where graduations land is an owner setting.</b> The
                launchpad&apos;s owner can point them at a different exchange. A
                wrong destination fails at deploy rather than quietly parking
                every graduation — but it is an owner power, and we are naming it.
              </li>
              <li>
                <b>A pool can be opened before graduation.</b> Anyone may open one
                for a curve token early and price it however they like.
                Graduation still deposits into the one we open; an early pool is
                just a worse price that existed first.
              </li>
              <li>
                <b>A curve can park.</b> Nothing forces a launch to reach 4 ETH.
                A token that never graduates stays tradeable on its curve
                indefinitely, and there is no refund mechanism, because there was
                never a raise held in escrow to refund.
              </li>
              <li>
                <b>Curve trades can be sandwiched</b> like any on-chain trade.
                The formula is public, which cuts both ways: you can compute your
                own fill, and so can somebody ahead of you.
              </li>
              <li>
                <b>Our share of the pool fee accrues where nobody can poke it.</b>{" "}
                A graduated pool&apos;s liquidity is burned, so the event that
                would settle that share never happens on its own — it sits
                uncollected until somebody adds liquidity. This is our accounting
                problem, and it is disclosed because it explains why a fee readout
                can show value that has not moved.
              </li>
              <li>
                <b>Running our own DEX costs distribution.</b> Aggregators and
                chart sites have no adapter for it, so a graduated token is not
                automatically visible where traders look. The alternative was
                having no testnet path at all.
              </li>
              <li>
                <b>The plates depend on a whitelabel Aave.</b> The health factor
                comes from a whitelabel Aave V3 market, fixed at deploy. If that
                market changes or empties, the plates read whatever it reports —
                that is the honest version of the premise: a plate tracks a
                leveraged position on the chain it lives on, so it inherits
                whatever lending market that chain has. The plate itself holds no
                approval, takes no custody and cannot liquidate anybody; it reads,
                and it draws.
              </li>
              <li>
                <b>Drowning is real, and anyone can do it.</b> Two conditions,
                both required: the plate has a position attached, and Aave reports
                a health factor at or below 1.0. A plate with nothing attached
                cannot be drowned by anyone, and attaching one is a choice — this
                is what the choice costs.
              </li>
              <li>
                <b>What the reveal does and does not promise.</b> The trait list
                is committed to a hash before minting can open, so the art cannot
                respond to demand, and no <i>mint</i> position can be timed to
                land a rare plate — the plate-to-slot offset does not exist until
                minting closes. But the draw itself is a one-shot call anyone can
                make, and whoever makes it can work out the offset they are about
                to get. We are saying that plainly rather than promising a fairness
                property nothing enforces.
              </li>
            </ul>

            <p className="field-note">
              Report anything else to the address in{" "}
              <a
                className="link"
                href={SECURITY_URL}
                target="_blank"
                rel="noreferrer"
              >
                SECURITY.md
              </a>
              , which also lists every domain and account that is actually ours.
            </p>
          </Section>

          <Section id="links">
            <div className="doc-links">
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                <span>Source</span>
                <span className="dim">
                  the code behind everything on this page
                </span>
              </a>
              <a href={SECURITY_URL} target="_blank" rel="noreferrer">
                <span>Security policy</span>
                <span className="dim">
                  how to report, deployed addresses, official accounts
                </span>
              </a>
              <a
                href={`${REPO_URL}/blob/main/ALLOWLIST.md`}
                target="_blank"
                rel="noreferrer"
              >
                <span>Allowlist criteria</span>
                <span className="dim">
                  how the plates allowlist is selected, published up front
                </span>
              </a>
              <a
                href="https://x.com/underwaterxyz"
                target="_blank"
                rel="noreferrer"
              >
                <span>@underwaterxyz on X</span>
                <span className="dim">
                  our only social account — no Discord, no Telegram, no group
                  chat, and anyone offering you one is not us
                </span>
              </a>
              <a
                href="https://explorer-sepolia.inkonchain.com"
                target="_blank"
                rel="noreferrer"
              >
                <span>Ink Sepolia explorer</span>
                <span className="dim">
                  where the full deploy can be read — every surface, including
                  the collection and the waterdrop
                </span>
              </a>
              <a
                href="https://explorer.testnet.chain.robinhood.com"
                target="_blank"
                rel="noreferrer"
              >
                <span>Robinhood Testnet explorer</span>
                <span className="dim">
                  the same launchpad, exchange and points on the other chain
                  family
                </span>
              </a>
            </div>
          </Section>
        </div>

        <nav className="doc-rail" aria-label="Contents">
          <div className="panel-head">
            <span>Contents</span>
          </div>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.label}</a>
              </li>
            ))}
          </ol>
          <p className="field-note">
            Last checked against the source on 31 August 2026. If a number here
            disagrees with{" "}
            <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
              the code
            </a>
            , the code is right and this is a bug.
          </p>
        </nav>
      </div>
    </div>
  );
}
