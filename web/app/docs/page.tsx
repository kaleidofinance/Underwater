import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Masthead } from "@/components/Chrome";
import { REPO_URL, SECURITY_URL } from "@/lib/links";

/**
 * /docs — the protocol, written down.
 *
 * A **server component**, and that is the whole design decision. Every other page
 * here is `"use client"` because it reads a chain; this one reads nothing, so it
 * ships as static HTML that a crawler, a reader with JavaScript off, and a
 * reviewer looking for who runs this site all get on the first byte. The masthead
 * is the one client island in it, imported across the boundary the way Next
 * intends.
 *
 * One route rather than a tree of them. A documentation site is a reading order,
 * and eleven sections that each fit on a screen read better as one scroll with a
 * contents rail than as eleven navigations — and there is no routing, no
 * generateStaticParams and no per-page metadata to keep in sync. If a section
 * outgrows the page it can be promoted to `/docs/<id>` later; the ids below are
 * already the URLs it would take.
 *
 * Nothing here restates a number that lives somewhere checkable. Deployed
 * addresses are in SECURITY.md — a fourth copy (env, that file, here, and the
 * explorer) is a fourth thing that can go stale on a page whose entire value is
 * being right. The constants *are* repeated from the contracts, because a reader
 * cannot follow a link mid-sentence and the whole point is to publish them; every
 * one was counted out of `src/` before it was written, which is the same rule
 * brand/README.md sets for the cards.
 *
 * The one claim this page deliberately does not make is a fairness promise about
 * `reveal()`. See the plates bullet under Risks: it states the mechanism, which is
 * true, instead of a guarantee the contract does not give.
 */

export const metadata: Metadata = {
  title: "Docs — underwater.fun",
  description:
    "How underwater.fun works: the bonding curve, graduation into a pool with burned liquidity, the plates collection, every fee and its hard cap, the contracts, and what is not built yet.",
  openGraph: {
    title: "Docs — underwater.fun",
    description:
      "The curve, graduation, the plates, every fee and its cap, and the contracts behind them.",
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
  { id: "fees", label: "Fees", kicker: "four, and their caps" },
  { id: "architecture", label: "Architecture", kicker: "the contracts" },
  { id: "tokens", label: "Tokens", kicker: "launches, and $water" },
  { id: "network", label: "Network", kicker: "ink mainnet, ink sepolia" },
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
          A launchpad on InkChain where the math is published before you buy. This
          page is the whole protocol in one scroll: the curve a token sells on,
          what graduation does to the liquidity, the plates collection that reads
          a lending position, every fee and the ceiling it cannot pass, and the
          list of things that are not finished. The source is{" "}
          <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
            public
          </a>
          , and every number below was counted out of it.
        </p>
      </header>

      <div className="stage doc-stage">
        <div className="doc-main">
          <Section id="overview">
            <p className="note">
              <b>underwater.fun</b> lets anyone create a token in one transaction
              and sell it on a bonding curve whose formula is fixed in the
              contract. There is no presale, no team allocation and no allowlist
              on the curve — being early to the curve is the only discount, and it
              is the same curve for every token.
            </p>
            <p className="note">
              At <b>4 ETH raised</b> the curve closes itself. The ETH and the
              200M tokens held back from the sale go into a real
              Uniswap-V2-style pool, and the LP tokens are sent to{" "}
              <code>0x…dEaD</code>. Not locked, not vested — burned. There is no
              key, no timelock and no multisig, because after graduation there is
              nobody left who could move that liquidity, including us.
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
                  <dt>Contracts live on</dt>
                  <dd>Ink Sepolia · 763373</dd>
                </div>
                <div className="r-row">
                  <dt>Ink Mainnet</dt>
                  <dd className="dim">not deployed</dd>
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
                The contracts are on a testnet and we are validating them in
                public before mainnet. Launching real money is not open yet.
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
              Our own Uniswap-V2 port, which is where a graduated token trades.
              It exists because Ink Sepolia has no V2 router at all, so without it
              the launchpad could not run end to end on a testnet. Swaps are
              ETH↔token.
            </Product>

            <Product name="Underwater Plates" href="/plates">
              2222 hydrographic survey plates, SVG generated on chain by five
              renderer contracts. Attach an Aave position and the drawing reads
              it: crisp in dry dock, dissolving into ink plumes as the health
              factor falls, burnable by anyone once it liquidates.
            </Product>

            <Product name="The waterdrop" href="/waterdrop">
              Allowlist intake for the plates mint. One transaction registers a
              wallet — no form, no email, and the contract only ever accepts a
              registration from the wallet being registered. Registration is
              intake, not entitlement: the allowlist is drawn from the registrants
              under criteria published before anyone could register.
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

            <p className="note">
              Two properties worth knowing because they cost you something.{" "}
              <b>Rounding always favours the pool</b> — buys round tokens out
              down, sells round ETH out down — so splitting a buy into ten never
              beats making it once, and a round trip never profits. Both are
              fuzzed over 10,000 runs in the test suite. And a curve that never
              reaches 4 ETH simply stays a curve: it does not expire, refund, or
              graduate on a timer.
            </p>
          </Section>

          <Section id="usage">
            <h3 className="doc-h">Launch a token</h3>
            <ol className="doc-steps">
              <li>
                Switch to Ink Sepolia and connect a wallet on{" "}
                <Link className="link" href="/create">
                  /create
                </Link>
                .
              </li>
              <li>
                Give it a name, a symbol and a metadata URI. The URI is one
                string on the token; the app pins the image for you.
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
              <li>
                The LP tokens are transferred to{" "}
                <code>0x000000000000000000000000000000000000dEaD</code>.
              </li>
              <li>
                Any curve tokens still unsold after the size-down are burned, so
                the circulating supply matches what was actually bought.
              </li>
            </ol>
            <p className="field-note">
              Graduation reserves 3,000,000 gas for that pool deposit. Without the
              reserve a buy submitted with a tight gas limit could complete the
              raise and then run out of gas mid-graduation, leaving a curve that
              had ended with no pool to trade in.
            </p>

            <h3 className="doc-h">Swap a graduated token</h3>
            <ol className="doc-steps">
              <li>
                Go to{" "}
                <Link className="link" href="/swap">
                  /swap
                </Link>
                , or use the swap panel on the token&apos;s own page.
              </li>
              <li>
                Pick a direction. Pairs are ETH↔token, routed through the WETH
                predeploy.
              </li>
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
                If the allowlist includes you, the allowlist phase takes a Merkle
                proof the app builds for you. Whatever the allowlist phase does
                not take rolls into the public phase.
              </li>
              <li>
                Mint on{" "}
                <Link className="link" href="/mint">
                  /mint
                </Link>
                . What you receive is a sealed tube: every plate looks identical
                until minting closes.
              </li>
              <li>
                After minting closes, <code>reveal()</code> draws the offset that
                maps plate numbers onto rows of the sealed trait table, and the
                art appears.
              </li>
            </ol>

            <h3 className="doc-h">Attach a position</h3>
            <p className="note">
              Optional, and the one decision on this page that can lose you the
              token. Point a plate at an address with an Aave position and the
              renderer starts reading that position on every view — the plate
              dissolves as the health factor falls, can be engraved with a scar
              below 1.4, and at 1.0 anyone may call <code>drown()</code> to burn
              it and mint themselves a trophy. A plate with nothing attached
              cannot be drowned by anybody. See{" "}
              <a className="link" href="#risks">
                Risks
              </a>
              .
            </p>
          </Section>

          <Section id="fees">
            <p className="note">
              There are <b>four</b>, and this is the complete list. Three belong
              to the launchpad and are settable by its owner within hard caps
              written into the contract; the fourth belongs to the DEX and only
              starts applying after a token graduates. If you find a fifth, it is
              a bug and we want the report.
            </p>

            <div className="doc-table-wrap">
              <table className="doc-table">
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
                    <td>1%</td>
                    <td>2%</td>
                    <td className="dim">on the curve</td>
                  </tr>
                  <tr>
                    <td>Token creation</td>
                    <td>0</td>
                    <td>0.01 ETH</td>
                    <td className="dim">once, at launch</td>
                  </tr>
                  <tr>
                    <td>Graduation, of the 4 ETH</td>
                    <td>5%</td>
                    <td>10%</td>
                    <td className="dim">once, at graduation</td>
                  </tr>
                  <tr>
                    <td>Pool swap</td>
                    <td>0.30%</td>
                    <td className="dim">hardcoded</td>
                    <td className="dim">after graduation</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="note">
              The caps are the part worth checking. A settable fee with no ceiling
              is a promise; a settable fee under <code>MAX_TRADE_FEE_BPS</code>,{" "}
              <code>MAX_GRADUATION_FEE_BPS</code> and <code>MAX_CREATION_FEE</code>{" "}
              is a bounded parameter, and the bound is enforced by the setter
              rather than by us.
            </p>

            <p className="note">
              The pool fee is not settable at all — 0.30% is hardcoded in{" "}
              <code>UnderwaterLibrary.getAmountOut</code>. What is switchable is
              the protocol&apos;s share of it: with <code>factory.feeTo</code>{" "}
              set, <code>UnderwaterPair._mintFee</code> mints the protocol ⅙ of
              the growth in √k on the next liquidity event, which works out to
              0.05% of swap volume. It is set on our deploy.
            </p>

            <p className="note">
              Two fees exist on the plates rather than the launchpad. The{" "}
              <b>mint price</b> is owner-settable under a <b>1 ETH ceiling</b>,
              because it targets a dollar figure while ETH moves.{" "}
              <b>Secondary royalty is 5%</b> — <code>ROYALTY_BPS = 500</code>,
              hardcoded, reported through ERC-2981.
            </p>
          </Section>

          <Section id="architecture">
            <p className="note">
              Solidity, Foundry, no proxies and no upgrade path anywhere. What is
              deployed is what runs.
            </p>

            <h3 className="doc-h">Launchpad</h3>
            <p className="note">
              <code>UnderwaterLaunchpad.sol</code> is the factory, the curve, the
              fee schedule and the graduation, in one contract. It holds the ETH a
              curve has raised and the tokens it has not sold; it mints a fresh{" "}
              <code>UnderwaterToken</code> per launch and emits a{" "}
              <code>Trade</code> event carrying both reserves and the running
              raise, so price, market cap and curve progress can be derived from
              logs with no follow-up call per trade.
            </p>

            <h3 className="doc-h">DEX</h3>
            <p className="note">
              A port of Uniswap V2 to Solidity 0.8.26 — factory, pair, router and
              library. Two things in it are not a copy. The V2 pair relies on
              deliberate overflow in two places inside <code>_update</code>, which
              0.8 reverts on, so those two sites are explicitly{" "}
              <code>unchecked</code> and nothing else is. And <code>pairFor</code>{" "}
              asks the factory registry for a pair address instead of computing it
              from a hard-coded init-code hash, because that hash changes with
              every compiler setting and a stale constant is a router that
              silently addresses pairs that do not exist. The DEX is{" "}
              <b>GPL-3.0-or-later</b>, as the code it derives from requires;
              everything else in the repo is MIT.
            </p>

            <h3 className="doc-h">Plates and the renderer</h3>
            <p className="note">
              <code>UnderwaterPlates.sol</code> holds the packed trait table, the
              mint phases and the dive mechanics. Drawing is{" "}
              <b>five separate contracts</b>, not one, because a single renderer
              that draws the whole plate does not fit under the 24KB contract-size
              limit — so the pigments, the frame, the chart, the dissolve and the
              assembly are deployed separately and composed. Their output is
              tested differentially against <code>art/render.py</code>: the same
              slot rendered by Python and by the chain has to produce the same
              SVG.
            </p>
            <p className="note">
              The Aave read is <b>read-only and one call deep</b>. The collection
              holds no approval, takes no custody, moves no collateral and cannot
              liquidate anybody — it asks a whitelabel Aave V3 pool for a health
              factor and draws the answer. <code>UnderwaterTrophy.sol</code>
              &nbsp;records a drowning as a <code>Kill</code>: the plate number,
              the block, the health factor and the hunter&apos;s address.
            </p>

            <h3 className="doc-h">Waitlist</h3>
            <p className="note">
              <code>UnderwaterWaitlist.sol</code> is intake and nothing else —{" "}
              <b>ownerless</b>, self-registration only, and a fixed window set at
              deploy. There is no admin function on it because there is no admin:
              it cannot add a wallet, remove one, or extend its own window. The
              allowlist is then selected off chain under{" "}
              <a
                className="link"
                href={`${REPO_URL}/blob/main/ALLOWLIST.md`}
                target="_blank"
                rel="noreferrer"
              >
                published criteria
              </a>{" "}
              and committed as a Merkle root — sorted pairs, double-hashed leaves.
            </p>

            <h3 className="doc-h">Frontend</h3>
            <p className="note">
              Next.js, wagmi and viem, reading chains directly with no backend of
              our own and no indexer yet. Curve history is read from{" "}
              <code>Trade</code> logs over a bounded block window, and the app
              tells you which window it actually got rather than presenting a
              partial history as a complete one.
            </p>
          </Section>

          <Section id="tokens">
            <h3 className="doc-h">A launch token</h3>
            <p className="note">
              Standard ERC-20, 18 decimals, minted by the launchpad. Fixed supply
              per launch, with no mint function reachable afterwards:
            </p>
            <div className="doc-table-wrap">
              <table className="doc-table">
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
                    <td>800,000,000</td>
                    <td>80%</td>
                    <td className="dim">to buyers; unsold remainder burned</td>
                  </tr>
                  <tr>
                    <td>Held for the pool</td>
                    <td>200,000,000</td>
                    <td>20%</td>
                    <td className="dim">paired with the raise; LP burned</td>
                  </tr>
                  <tr>
                    <td>Team, presale, advisors</td>
                    <td>0</td>
                    <td>0%</td>
                    <td className="dim">there is no allocation</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className="doc-h">Underwater Plates</h3>
            <p className="note">
              ERC-721, <b>2222</b> supply, capped in the contract. The allowlist
              phase is allocated 2000 and the public phase takes whatever it does
              not use. Per-wallet limits are settable under a ceiling of 222.
              Royalty is 5%. Metadata is not hosted anywhere — <code>tokenURI</code>{" "}
              returns a data URI the renderer contracts build at call time.
            </p>

            <h3 className="doc-h">$WATER</h3>
            <p className="note">
              <b>$WATER is coming, and it does not exist yet.</b> There is no
              contract, no address and nothing to claim — a protocol token planned
              to be shared with the people who make the market: token{" "}
              <b>creators</b>, <b>liquidity providers</b> and <b>traders</b>. The{" "}
              <Link className="link" href="/profile">
                profile
              </Link>{" "}
              page already shows the activity a distribution would draw on. There
              is no sale, no allocation table and no date, and anything you read
              elsewhere offering to sell you one is not us — see the{" "}
              <a
                className="link"
                href={SECURITY_URL}
                target="_blank"
                rel="noreferrer"
              >
                security policy
              </a>{" "}
              for the exhaustive list of accounts and domains that are.
            </p>
          </Section>

          <Section id="network">
            <p className="note">
              Two networks. <b>Ink Mainnet</b> and <b>Ink Sepolia</b> name actual
              chains — what a wallet has to be switched to, where a pool opens.
              &ldquo;InkChain&rdquo; is the brand word, and it is never a claim
              about where something is deployed.
            </p>

            <div className="doc-table-wrap">
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>&nbsp;</th>
                    <th>Ink Mainnet</th>
                    <th>Ink Sepolia</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Chain ID</td>
                    <td>57073</td>
                    <td>763373</td>
                  </tr>
                  <tr>
                    <td>Gas token</td>
                    <td>ETH</td>
                    <td>ETH</td>
                  </tr>
                  <tr>
                    <td>Explorer</td>
                    <td className="dim">explorer.inkonchain.com</td>
                    <td className="dim">explorer-sepolia.inkonchain.com</td>
                  </tr>
                  <tr>
                    <td>Our contracts</td>
                    <td className="dim">not deployed</td>
                    <td>live</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="note">
              Both expose the standard OP Stack WETH predeploy at{" "}
              <code>0x4200…0006</code> with identical bytecode, which is what lets
              one router build serve both. Multicall3 is at the canonical{" "}
              <code>0xcA11…CA11</code> on each, and the app batches its reads
              through it.
            </p>

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
              verification is still outstanding, so verify bytecode against a
              local build rather than trusting an explorer label.
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
                <b>Validate on Ink Sepolia, in public.</b> Where we are. The
                launchpad, the collection and the waitlist are deployed and the
                whole lifecycle runs against the real chain.
              </li>
              <li>
                <b>Explorer source verification</b> for every deployed contract,
                so the bytecode a reader checks is labelled by the explorer as
                well as by us.
              </li>
              <li>
                <b>An audit.</b> Before real money, not after it. 354 tests
                including fuzz runs and live-fork tests is not an audit, and the
                DEX port raises the stakes rather than lowering them.
              </li>
              <li>
                <b>The plates drop.</b> The waterdrop window closes, the
                allowlist is selected under the published criteria and committed
                as a Merkle root, and minting opens.
              </li>
              <li>
                <b>Ink Mainnet.</b> The same contracts, once Sepolia validation is
                clean and the audit is done. We will post the block the first
                curve graduates in.
              </li>
              <li>
                <b>$WATER.</b> The protocol token, to creators, liquidity
                providers and traders.
              </li>
              <li>
                <b>An indexer, and aggregator listings.</b> The events are
                already shaped for it — <code>Trade</code> on the curve, standard
                V2 <code>Swap</code>/<code>Sync</code> after graduation, so one
                indexer covers both halves of a token&apos;s life.
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
                <b>No audit.</b> 354 passing tests, 10k-run fuzz invariants and
                live-fork tests against both Ink chains. That is diligence, not
                assurance.
              </li>
              <li>
                <b>The router is settable.</b> The launchpad&apos;s owner can
                point graduations at a different V2 router. The deploy script
                refuses any address that does not answer <code>factory()</code>{" "}
                and <code>WETH()</code>, so a wrong one fails loudly at deploy
                rather than parking every graduation — but it is an owner power,
                and we are naming it.
              </li>
              <li>
                <b>A pair can be created before graduation.</b> Anyone may open a
                pool for a curve token early and price it however they like.
                Graduation still deposits into the canonical pair; an early pool
                is just a worse price that existed first.
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
                <b>Fees accrue in a pool nobody can poke.</b> A graduated
                pool&apos;s base liquidity is burned, so no ordinary liquidity
                event happens — the protocol&apos;s ⅙ share sits unminted until
                someone deposits dust to settle it. This is our accounting
                problem, and it is disclosed because it explains why a fee
                readout can show value that has not moved.
              </li>
              <li>
                <b>Running our own DEX costs distribution.</b> Aggregators and
                chart sites have no adapter for our factory, so a graduated token
                is not automatically visible where traders look. The alternative
                was having no testnet path at all.
              </li>
              <li>
                <b>The plates depend on a whitelabel Aave.</b> The health factor
                comes from <code>AaveV3InkWhitelabel</code> through an immutable
                pool address. If that market changes or empties, the plates read
                whatever it reports — that is the honest version of the premise:
                a plate tracks a leveraged position on the chain it lives on, and
                so it inherits whatever lending market that chain has.
              </li>
              <li>
                <b><code>drown()</code> is real and unpermissioned.</b> Two
                conditions, in the order the contract checks them: the plate has a
                position attached, and Aave reports a health factor at or below
                1.0. Both must hold. A plate with nothing attached cannot be
                drowned by anyone, and attaching one is a choice — this is what
                the choice costs.
              </li>
              <li>
                <b>What <code>reveal()</code> does and does not promise.</b> The
                trait table is committed to a hash before minting can open, so the
                art cannot respond to demand, and no <i>mint</i> position can be
                timed to land a rare plate — the plate-to-slot offset does not
                exist until minting closes. What draws it is{" "}
                <code>blockhash(block.number - 1)</code> in an unpermissioned,
                one-shot call, so the first caller can compute the offset they are
                about to get. We are stating the mechanism rather than promising a
                fairness property the contract does not enforce.
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
                  every contract, test and script in this document
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
                <span>@underwaterxyz</span>
                <span className="dim">
                  the only account we post from
                </span>
              </a>
              <a
                href="https://explorer-sepolia.inkonchain.com"
                target="_blank"
                rel="noreferrer"
              >
                <span>Ink Sepolia explorer</span>
                <span className="dim">where the live contracts can be read</span>
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
            Last counted out of the contracts on 30 August 2026. If a number here
            disagrees with{" "}
            <a className="link" href={REPO_URL} target="_blank" rel="noreferrer">
              the source
            </a>
            , the source is right and this is a bug.
          </p>
        </nav>
      </div>
    </div>
  );
}
