/**
 * Per-client rate limits: a token bucket per key (the client's IP), refilled
 * continuously. Reads get a generous budget; writes, which run engine
 * commands, a tighter one. In-memory on purpose: one process serves the API.
 */

export interface Budget {
  /** Most requests in a burst. */
  readonly burst: number;
  /** Sustained requests per minute. */
  readonly perMinute: number;
}

export const READ_BUDGET: Budget = { burst: 60, perMinute: 240 };
export const WRITE_BUDGET: Budget = { burst: 10, perMinute: 30 };
/** Live streams (SSE) one client may hold open at once. */
export const MAX_STREAMS_PER_CLIENT = 4;

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  readonly #budget: Budget;
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(budget: Budget, now: () => number = Date.now) {
    this.#budget = budget;
    this.#now = now;
  }

  /** Take one request's worth. Returns 0 if allowed, else the seconds to wait. */
  take(key: string): number {
    const now = this.#now();
    const refill = this.#budget.perMinute / 60_000;
    const b = this.#buckets.get(key) ?? { tokens: this.#budget.burst, at: now };
    b.tokens = Math.min(this.#budget.burst, b.tokens + (now - b.at) * refill);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.#buckets.set(key, b);
      this.#sweep(now);
      return 0;
    }
    this.#buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / refill / 1000);
  }

  /** Drop buckets that have refilled completely, so memory tracks active clients only. */
  #sweep(now: number): void {
    if (this.#buckets.size < 10_000) return;
    const full = (this.#budget.burst / this.#budget.perMinute) * 60_000;
    for (const [k, b] of this.#buckets) if (now - b.at > full) this.#buckets.delete(k);
  }
}

/**
 * The client's IP. Railway's edge sets x-forwarded-for with the client first;
 * locally there's no proxy and the socket address is the client.
 */
export function clientKey(headers: Record<string, string | string[] | undefined>, socketAddress: string | undefined): string {
  const fwd = headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || socketAddress || "unknown";
}
