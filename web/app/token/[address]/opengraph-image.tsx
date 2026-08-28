import { ImageResponse } from "next/og";
import {
  Badge,
  brandFonts,
  CARD,
  cardCache,
  Datum,
  Depth,
  DIM,
  FAINT,
  FONT,
  HAIR,
  PALETTE,
  Rubric,
  Scene,
  TokenPlate,
} from "@/lib/og";
import { CURVE } from "@/lib/contracts";
import { fmtEth, fmtPriceGwei, shortAddr } from "@/lib/format";
import { readTokenCard } from "@/lib/og-data";
import SiteImage from "../../opengraph-image";

/**
 * A launch's share card.
 *
 * The point of this route is that a token link stops being a link. Pasted into
 * X or Discord it becomes the specimen sheet: the creator's art, the name, what
 * it costs, and how close it is to graduating — which is the one number that
 * makes a bonding curve worth watching and the one a bare URL cannot convey.
 *
 * The water is the mechanism, not decoration. `Scene`'s `t` is curve progress,
 * so the card for a launch nobody has bought is deep and dim, and the card for
 * one at 90% is nearly bare paper. Two cards from the same site, side by side in
 * a feed, tell you which launch is nearly done before you have read a digit.
 *
 * When there is nothing to draw — a malformed address, a token on a chain with no
 * launchpad, an address with no launch — this falls back to the site card rather
 * than rendering an apology. A crawler caches whatever it is handed, so "we could
 * not find that" would outlive the reason it was true, and a brand poster is
 * never wrong.
 */

export const alt = "A launch on underwater.fun";
export const size = CARD;
export const contentType = "image/png";

/**
 * Ten minutes for a card that resolved, one for one that did not.
 *
 * Long enough that a link doing the rounds is served from the CDN rather than
 * costing a batch of RPC reads, a gateway fetch and a 1200×630 encode per crawl,
 * and short enough that a card reshared an hour later is not quoting an hour-old
 * price. The numbers on a card are a snapshot by nature — nobody trades off an
 * image — so this is tuned for the crawlers' benefit rather than for freshness.
 *
 * The miss gets a minute because the most likely reason for one is a token
 * launched seconds ago, or one RPC request that happened to drop. Both fix
 * themselves, and neither is worth remembering for ten minutes.
 */
const FRESH = 600;
const MISS = 60;

export default async function Image({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const t = await readTokenCard(address);

  if (!t) {
    // The site card, but on the miss clock. `ImageResponse` is a `Response`, so
    // its body can be passed straight through with the header replaced rather
    // than rendering the same pixels a second time.
    const fallback = await SiteImage();
    return new Response(fallback.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": cardCache(MISS),
      },
    });
  }

  const progressPct = Math.min(100, t.progress / 100);

  return new ImageResponse(
    (
      <Scene t={t.progress / 10_000}>
        <Rubric right={t.chainName} />

        <div
          style={{
            display: "flex",
            flexGrow: 1,
            alignItems: "center",
            gap: 38,
            paddingTop: 30,
            paddingBottom: 30,
          }}
        >
          <TokenPlate token={t.token} symbol={t.symbol} art={t.art} size={188} />

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flexGrow: 1,
              gap: 14,
              // Every child of this column is width-bounded by it rather than by
              // itself, so a 40-character token name cannot push the badge on the
              // right off the plate. Satori's flexbox will happily overflow.
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 20,
              }}
            >
              <span
                style={{
                  fontFamily: FONT.display,
                  // Stepped rather than fluid: Satori has no way to measure text
                  // and shrink to fit, so the size is chosen from the length up
                  // front and `ellipsis` catches whatever still does not fit.
                  fontSize: displaySize(t.name),
                  lineHeight: 1.02,
                  letterSpacing: -1.6,
                  color: PALETTE.washi,
                  maxWidth: 660,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.name || "—"}
              </span>

              {t.graduated && <Badge gold>Graduated</Badge>}
            </div>

            <div
              style={{
                display: "flex",
                fontFamily: FONT.mono,
                fontWeight: 400,
                fontSize: 17,
                letterSpacing: 1.6,
                color: FAINT,
              }}
            >
              {`${t.symbol || "—"}  ·  ${shortAddr(t.token)}`}
            </div>

            {/* The hero price, in the unit the page uses. Gwei rather than USD:
                the page converts when it has a rate, and adding a price-feed
                request to a crawler's budget to save a reader one unit
                conversion is not a trade worth making. */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 8 }}>
              <span
                style={{
                  fontFamily: FONT.mono,
                  fontWeight: 500,
                  fontSize: 54,
                  letterSpacing: -1,
                  color: PALETTE.washi,
                }}
              >
                {fmtPriceGwei(t.priceE18)}
              </span>
              <span
                style={{
                  fontFamily: FONT.mono,
                  fontWeight: 400,
                  fontSize: 17,
                  letterSpacing: 1.4,
                  color: DIM,
                }}
              >
                {`GWEI PER ${(t.symbol || "TOKEN").toUpperCase()}${t.fromPool ? " · IN THE POOL" : ""}`}
              </span>
            </div>
          </div>
        </div>

        {/* The depth bar, and under it the same two captions as `.depth-cap` —
            what has been raised on the left, the percentage on the right, gold
            once it is full. The launchpad zeroes `realEthRaised` at graduation
            (the ETH has gone into the pool), so reading the counter back on a
            graduated token would print "0 / 4 ETH raised" beside 100%. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <Depth progress={t.progress} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: FONT.mono,
              fontWeight: 400,
              fontSize: 14,
              letterSpacing: 1.8,
              color: DIM,
            }}
          >
            <span>
              {t.graduated
                ? `GRADUATED AT ${fmtEth(CURVE.graduationEth)} ETH`
                : `${fmtEth(t.realEthRaised)} / ${fmtEth(CURVE.graduationEth)} ETH RAISED`}
            </span>
            <span style={{ color: t.progress >= 10_000 ? PALETTE.goldleaf : DIM }}>
              {`${progressPct.toFixed(1)}%`}
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            marginTop: 26,
            paddingTop: 22,
            borderTop: `1px solid ${HAIR}`,
          }}
        >
          <Datum label="Market cap" value={`${fmtEth(t.marketCap, 4)} ETH`} />
          <Datum
            label={t.graduated ? "Liquidity" : "Graduates at"}
            value={t.graduated ? "LP burned" : `${fmtEth(CURVE.graduationEth)} ETH`}
            gold={t.graduated}
          />
          <Datum label="Launched" value={launchedOn(t.createdAt)} />
        </div>
      </Scene>
    ),
    { ...size, fonts: await brandFonts(), headers: { "cache-control": cardCache(FRESH) } },
  );
}

/** A display size that keeps the name on one line for the lengths that matter. */
function displaySize(name: string): number {
  const n = name.length;
  if (n <= 12) return 68;
  if (n <= 18) return 56;
  if (n <= 26) return 44;
  return 36;
}

/**
 * A date rather than `fmtAge`'s "3d".
 *
 * The page can say "launched 3d ago" because it is re-rendered every time it is
 * opened. A card is rendered once and then cached — by us for ten minutes, and by
 * the crawler for as long as it likes — so a relative age is a number that starts
 * out true and quietly stops being true. An absolute date never does.
 */
function launchedOn(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
