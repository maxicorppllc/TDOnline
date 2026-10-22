// Flow fields: one Dijkstra map per base, distance-to-core for every tile.
// Buildings aren't walls in the pathing sense, they're expensive tiles. The horde
// takes a long detour around your maze, but if the detour costs more than smashing
// through, they smash through. That way blocking a path never breaks the game.

const SQ2 = Math.SQRT2;
export const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQ2], [1, -1, SQ2], [-1, 1, SQ2], [-1, -1, SQ2],
];

export interface PathGrid {
  size: number;
  /** 1 where the terrain can be walked at all. */
  walk: Uint8Array;
  /** Cost of stepping onto a tile. 1 for open ground, much more for buildings. */
  cost: Float32Array;
  /** 1 where nothing blocks movement; used so the horde can't slip between diagonal walls. */
  open: Uint8Array;
}

class Heap {
  idx: Int32Array;
  pri: Float64Array;
  n = 0;

  constructor(cap: number) {
    this.idx = new Int32Array(cap);
    this.pri = new Float64Array(cap);
  }

  push(i: number, p: number): void {
    if (this.n >= this.idx.length) this.grow();
    let k = this.n++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (this.pri[parent] <= p) break;
      this.idx[k] = this.idx[parent];
      this.pri[k] = this.pri[parent];
      k = parent;
    }
    this.idx[k] = i;
    this.pri[k] = p;
  }

  /** Pops the minimum; returns its index and leaves its priority in `top`. */
  top = 0;
  pop(): number {
    const out = this.idx[0];
    this.top = this.pri[0];
    const n = --this.n;
    if (n > 0) {
      const li = this.idx[n], lp = this.pri[n];
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= n) break;
        if (c + 1 < n && this.pri[c + 1] < this.pri[c]) c++;
        if (this.pri[c] >= lp) break;
        this.idx[k] = this.idx[c];
        this.pri[k] = this.pri[c];
        k = c;
      }
      this.idx[k] = li;
      this.pri[k] = lp;
    }
    return out;
  }

  private grow(): void {
    const idx = new Int32Array(this.idx.length * 2);
    const pri = new Float64Array(this.pri.length * 2);
    idx.set(this.idx);
    pri.set(this.pri);
    this.idx = idx;
    this.pri = pri;
  }
}

let heap: Heap | null = null;

export function computeField(g: PathGrid, goals: number[], out: Float32Array): void {
  const { size, walk, cost, open } = g;
  if (!heap) heap = new Heap(size * size * 2);
  const h = heap;
  h.n = 0;
  out.fill(Infinity);
  for (const i of goals) {
    out[i] = 0;
    h.push(i, 0);
  }
  while (h.n > 0) {
    const u = h.pop();
    const p = h.top;
    if (p > out[u]) continue;
    const ux = u % size, uy = (u / size) | 0;
    const ec = p === 0 ? 1 : cost[u];
    for (let d = 0; d < 8; d++) {
      const [dx, dy, len] = DIRS[d];
      const vx = ux + dx, vy = uy + dy;
      if (vx < 0 || vy < 0 || vx >= size || vy >= size) continue;
      const v = vy * size + vx;
      if (!walk[v]) continue;
      if (dx !== 0 && dy !== 0 && (!open[uy * size + vx] || !open[vy * size + ux])) continue;
      // Round to float32 so the heap and `out` agree exactly; otherwise rounding
      // slack makes tiles re-expand over and over.
      const nd = Math.fround(p + len * ec);
      if (nd < out[v]) {
        out[v] = nd;
        h.push(v, nd);
      }
    }
  }
}

/** Best neighbouring tile to step onto from (x, y), or -1 if the field can't help. */
export function nextStep(g: PathGrid, field: Float32Array, x: number, y: number): number {
  const { size, walk, cost, open } = g;
  let best = -1;
  let bv = Infinity;
  for (let d = 0; d < 8; d++) {
    const [dx, dy, len] = DIRS[d];
    const ux = x + dx, uy = y + dy;
    if (ux < 0 || uy < 0 || ux >= size || uy >= size) continue;
    const u = uy * size + ux;
    if (!walk[u]) continue;
    if (dx !== 0 && dy !== 0 && (!open[y * size + ux] || !open[uy * size + x])) continue;
    const du = field[u];
    if (du === Infinity) continue;
    const v = du === 0 ? 0 : du + len * cost[u];
    if (v < bv) {
      bv = v;
      best = u;
    }
  }
  return best;
}
