/**
 * The share card, drawn for X at 1200×630 by next/og. One design for both
 * the site's own card and each person's referral card.
 *
 * The Zcash mark appears only as a "built on Zcash" badge: the project's own
 * brand stays underwater.fun, so a card can never pass for Zcash's own.
 */

export const CARD_SIZE = { width: 1200, height: 630 };

/** The official Zcash mark (2024–present), inlined so rendering needs no fetch. */
const ZCASH_MARK =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="65" height="65"><path fill="#f3b724" d="M32.5 0A32.5 32.5 0 1 1 0 32.5 32.5 32.5 0 0 1 32.5 0"/><path fill="#fff" d="M29.591 13v5.146H21v6.2h13.33L21 41.974v4.667h8.591v5.113h5.279v-5.113h8.59v-6.2H30.131L43.46 22.813v-4.667h-8.59V13Z"/></svg>',
  ).toString("base64");

const GOLD = "#f3b724";
const INK = "#eef3f5";
const DIM = "#8fa6ad";

export interface CardData {
  handle?: string;
  rank?: number;
  points?: number;
  referrals?: number;
  code?: string;
}

export function Card({ handle, rank, points, referrals, code }: CardData) {
  const personal = handle !== undefined;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px 64px",
        color: INK,
        fontFamily: "sans-serif",
        // Deep water: light from above, dark below.
        background: "linear-gradient(180deg, #0f3a45 0%, #071b22 55%, #02080b 100%)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>
          under<span style={{ color: GOLD }}>water</span>.fun
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 24, color: DIM }}>
          built on
          <img src={ZCASH_MARK} width={44} height={44} alt="" />
          <span style={{ color: INK }}>Zcash</span>
        </div>
      </div>

      {personal ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 34, color: DIM }}>@{handle} is in line for the</div>
          <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.05 }}>first meme launchpad on Zcash</div>
          <div style={{ display: "flex", gap: 56, marginTop: 36 }}>
            {[
              ["rank", `#${rank}`],
              ["points", String(points)],
              ["referrals", String(referrals)],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 22, color: DIM, textTransform: "uppercase", letterSpacing: 3 }}>{k}</div>
                <div style={{ fontSize: 72, fontWeight: 700, color: k === "rank" ? GOLD : INK }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>The meme launchpad is coming to Zcash</div>
          <div style={{ fontSize: 34, color: DIM, marginTop: 20 }}>Launch a token in seconds. Trade it instantly. Join the waitlist.</div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: DIM }}>
        <span>{personal ? `join with code ${code}` : "underwater.fun"}</span>
        <span style={{ color: GOLD }}>{personal ? "+50 points for you both" : "earn points with your link"}</span>
      </div>
    </div>
  );
}
