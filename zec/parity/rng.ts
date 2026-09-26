/** Seeded PRNG (mulberry32), so every scenario and fuzz run is reproducible from its seed. */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.#state = (this.#state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new RangeError("pick from an empty list");
    return item;
  }

  /** Uniform bigint in [0, max]. */
  below(max: bigint): bigint {
    if (max <= 0n) return 0n;
    const bits = max.toString(2).length;
    let r = 0n;
    for (let i = 0; i < bits + 32; i += 32) r = (r << 32n) | BigInt(Math.floor(this.next() * 2 ** 32));
    return r % (max + 1n);
  }

  /** Log-uniform bigint between 10^lo and 10^hi: spreads trades across many orders of magnitude. */
  logUniform(lo: number, hi: number): bigint {
    const exponent = lo + this.next() * (hi - lo);
    const whole = Math.floor(exponent);
    const mantissa = BigInt(Math.floor(10 ** (exponent - whole) * 1e6));
    return (mantissa * 10n ** BigInt(whole)) / 1_000_000n;
  }
}
