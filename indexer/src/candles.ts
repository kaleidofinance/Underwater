import type { Context } from "ponder:registry";
import { candle } from "ponder:schema";

/**
 * The timeframes a chart can ask for.
 *
 * Four rows written per fill, which sounds wasteful until you compare it with the
 * alternative: a `GROUP BY` over every fill in the window, on every chart load, for
 * every visitor. A candle row is written a handful of times and read forever.
 *
 * One minute up to one day, chosen against the chains rather than by convention. Ink
 * produces a block a second and Robinhood one every tenth of a second, so a minute
 * bucket holds 60 and 600 blocks respectively — fine grain on both, where a
 * fifteen-second bucket would be mostly empty on Ink and a five-minute one would hide
 * the first minutes of a launch, which is when a launch is most watched.
 */
export const INTERVALS = [60, 300, 3_600, 86_400] as const;

/**
 * The handler's own store, taken off `Context` rather than described here — a
 * hand-written shape would either be wrong or be `any`, and either way the `values`
 * object below would stop being checked against the schema.
 */
type Db = Context["db"];

/**
 * Fold one fill into every timeframe's bucket.
 *
 * `open` is set only when the bucket is created and never touched again, which is
 * exactly what `onConflictDoUpdate` gives for free: the insert branch runs once. `high`
 * and `low` are widened, `close` overwritten, volume and count accumulated.
 *
 * Deliberately does *not* carry a candle forward into a bucket with no trades. A gap in
 * this table means "nothing traded", which is true and useful; a chart that wants a
 * flat line through a quiet hour can draw one from the previous close, and one that
 * wants to show the quiet hour as quiet can do that too. Writing the flat candle here
 * would take that choice away and store a row per interval per token per minute
 * forever, for every launch that has ever existed.
 */
export async function recordCandles(
  db: Db,
  args: {
    chainId: number;
    token: `0x${string}`;
    timestamp: number;
    priceE18: bigint;
    ethAmount: bigint;
  },
) {
  const { chainId, token, timestamp, priceE18, ethAmount } = args;

  for (const interval of INTERVALS) {
    const bucket = Math.floor(timestamp / interval) * interval;
    await db
      .insert(candle)
      .values({
        id: `${chainId}-${token}-${interval}-${bucket}`,
        chainId,
        token,
        interval,
        bucket,
        open: priceE18,
        high: priceE18,
        low: priceE18,
        close: priceE18,
        volumeWei: ethAmount,
        trades: 1,
      })
      .onConflictDoUpdate((row) => ({
        high: row.high > priceE18 ? row.high : priceE18,
        low: row.low < priceE18 ? row.low : priceE18,
        close: priceE18,
        volumeWei: row.volumeWei + ethAmount,
        trades: row.trades + 1,
      }));
  }
}
