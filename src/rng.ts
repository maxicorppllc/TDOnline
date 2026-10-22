// Small seeded RNG (mulberry32) so a match can be replayed from its seed.
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed | 0;
  }

  /** Internal state, for saving and restoring a match. */
  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v | 0;
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Inclusive integer range. */
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
