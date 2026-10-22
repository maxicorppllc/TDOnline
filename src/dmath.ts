// Deterministic math for the simulation.
//
// Online, every browser runs its own copy of the match and they must stay
// bit-identical. JavaScript only guarantees exact results for + - * / and sqrt;
// Math.sin, cos, atan2 and hypot may round differently in Chrome, Firefox and
// Safari. These versions use plain arithmetic only, so they match everywhere.

const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TAU = 6.283185307179586;
const INV_SQ3 = 1 / Math.sqrt(3);
const TAN_15 = 0.2679491924311227;

export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Taylor series, accurate to ~1e-9 on [-π/2, π/2]. */
function sinCore(x: number): number {
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))));
}

export function sin(x: number): number {
  let r = x - TAU * Math.round(x / TAU);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  return sinCore(r);
}

export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/** atan for t in [0, 1], reduced to |t| <= tan(15°) where the series converges fast. */
function atan01(t: number): number {
  let off = 0;
  if (t > TAN_15) {
    t = (t - INV_SQ3) / (1 + t * INV_SQ3);
    off = PI / 6;
  }
  const t2 = t * t;
  return off + t * (1 - t2 * (1 / 3 - t2 * (1 / 5 - t2 * (1 / 7 - t2 * (1 / 9 - t2 * (1 / 11 - t2 * (1 / 13 - t2 / 15)))))));
}

export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x), ay = Math.abs(y);
  let a = ax >= ay ? atan01(ay / ax) : HALF_PI - atan01(ax / ay);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}
