import { Rng } from './rng.ts';
import { cos, hypot, sin } from './dmath.ts';

export const T_GRASS = 0;
export const T_DIRT = 1;
export const T_WATER = 2;
export const T_ROCK = 3;
export const T_TREE = 4;
export const T_VOID = 5;
export const T_CORRUPT = 6;

export interface BaseSpot {
  /** Centre tile of the 3x3 core. */
  tx: number;
  ty: number;
  angle: number;
}

export interface MapData {
  size: number;
  tiles: Uint8Array;
  /** Portal centre, in tile units (a point, not a tile index). */
  center: number;
  radius: number;
  ringR: number;
  bases: BaseSpot[];
}

export const PORTAL_CLEAR = 6;

export function isWalkableKind(k: number): boolean {
  return k === T_GRASS || k === T_DIRT || k === T_CORRUPT;
}

export function isBuildableKind(k: number): boolean {
  return k === T_GRASS || k === T_DIRT;
}

function valueNoise(rng: Rng, size: number, scale: number): (x: number, y: number) => number {
  const gw = Math.ceil(size / scale) + 3;
  const g = new Float32Array(gw * gw);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  return (x, y) => {
    const fx = x / scale, fy = y / scale;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1];
    const c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    const top = a + (b - a) * sx, bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  };
}

function fractal(rng: Rng, size: number, scale: number): (x: number, y: number) => number {
  const a = valueNoise(rng, size, scale);
  const b = valueNoise(rng, size, scale / 2.5);
  return (x, y) => a(x, y) * 0.65 + b(x, y) * 0.35;
}

/** Ring radius (portal to each core) for a given lobby size. */
export function ringRadius(players: number): number {
  return Math.round(18 + players * 3.2);
}

export function generateMap(players: number, seed: number): MapData {
  const rng = new Rng(seed);
  const ringR = ringRadius(players);
  const radius = ringR + 13;
  const size = radius * 2 + 10;
  const c = size / 2;
  const tiles = new Uint8Array(size * size);

  const forest = fractal(rng, size, 9);
  const water = fractal(rng, size, 11);
  const edge = valueNoise(rng, size, 6);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = hypot(x + 0.5 - c, y + 0.5 - c);
      const edgeR = radius + (edge(x, y) - 0.5) * 5;
      let k = T_GRASS;
      if (d > edgeR) k = T_VOID;
      else if (d < 5) k = T_CORRUPT;
      else if (d > 9) {
        if (water(x, y) > 0.72) k = T_WATER;
        else if (forest(x, y) > 0.64 && rng.chance(0.85)) k = T_TREE;
        else if (rng.chance(0.012)) k = T_ROCK;
      }
      tiles[y * size + x] = k;
    }
  }

  const bases: BaseSpot[] = [];
  for (let i = 0; i < players; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / players;
    const tx = Math.floor(c + cos(angle) * ringR);
    const ty = Math.floor(c + sin(angle) * ringR);
    bases.push({ tx, ty, angle });
    for (let y = ty - 8; y <= ty + 8; y++) {
      for (let x = tx - 8; x <= tx + 8; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = hypot(x - tx, y - ty);
        const i2 = y * size + x;
        if (tiles[i2] === T_VOID) continue;
        if (d <= 3.2) tiles[i2] = T_DIRT;
        else if (d <= 7.5) tiles[i2] = T_GRASS;
      }
    }
  }

  // Make sure the horde can reach every base. Carve a corridor wherever it can't.
  for (let pass = 0; pass < 3; pass++) {
    const seen = floodFrom(tiles, size, Math.floor(c), Math.floor(c));
    let carved = false;
    for (const b of bases) {
      if (seen[b.ty * size + b.tx]) continue;
      carved = true;
      const steps = Math.ceil(hypot(b.tx - c, b.ty - c) * 2);
      for (let s = 0; s <= steps; s++) {
        const px = c + ((b.tx + 0.5 - c) * s) / steps;
        const py = c + ((b.ty + 0.5 - c) * s) / steps;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const i2 = Math.floor(py + oy) * size + Math.floor(px + ox);
            const k = tiles[i2];
            if (k === T_WATER || k === T_TREE || k === T_ROCK) tiles[i2] = T_GRASS;
          }
        }
      }
    }
    if (!carved) break;
  }

  return { size, tiles, center: c, radius, ringR, bases };
}

function floodFrom(tiles: Uint8Array, size: number, sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(size * size);
  const stack = [sy * size + sx];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % size, y = (i / size) | 0;
    const n = [i - 1, i + 1, i - size, i + size];
    const ok = [x > 0, x < size - 1, y > 0, y < size - 1];
    for (let k = 0; k < 4; k++) {
      if (!ok[k]) continue;
      const j = n[k];
      if (seen[j] || !isWalkableKind(tiles[j])) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}
