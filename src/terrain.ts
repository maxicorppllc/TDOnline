// Pre-renders the whole island once: grass, dirt, ponds, the corrupted ground
// round the portal, trees, rocks, and the cliffs dropping into the void.

import { T_CORRUPT, T_DIRT, T_ROCK, T_TREE, T_VOID, T_WATER } from './map.ts';
import type { MapData } from './map.ts';
import { TILE, hexRgb, makeCanvas, outline, shade } from './sprites.ts';

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(x: number, y: number, scale: number, s: number): number {
  const fx = x / scale, fy = y / scale;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

const rgb = (hex: string) => hexRgb(hex);
const GRASS = ['#3b763a', '#468640', '#509346', '#5c9f4f'].map(rgb);
const DIRT = ['#6f5337', '#7c5e3e', '#8a6a47', '#98764f'].map(rgb);
const CORRUPT = ['#221a31', '#2b213d', '#352848', '#3f2f55'].map(rgb);
const WATER = ['#27507f', '#2c5a8c', '#31639a'].map(rgb);
const FLOWERS = ['#f6e27a', '#ffffff', '#f49ac1', '#9fd3ff'].map(rgb);
const CLIFF = ['#3a6a34', '#6e5236', '#5d4a3c', '#4f4152', '#433857', '#342d47', '#272238'].map(rgb);
const VOID = rgb('#0b0d1a');

function treeSprite(kind: number): HTMLCanvasElement {
  const c = makeCanvas(18, 26);
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const px = (x: number, y: number, col: string) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
  g.fillStyle = '#5c3a2b';
  g.fillRect(8, 18, 2, 7);
  g.fillStyle = '#7a5038';
  g.fillRect(8, 18, 1, 7);
  if (kind < 2) {
    const base = kind === 0 ? '#2f6e33' : '#3a7a2e';
    for (let y = 0; y < 22; y++) {
      for (let x = 0; x < 18; x++) {
        const blobs = [[9, 9, 7.5], [5, 13, 4.5], [13, 13, 4.5], [9, 5, 5]];
        let inside = false;
        for (const [bx, by, r] of blobs) if (Math.hypot(x + 0.5 - bx, y + 0.5 - by) < r) inside = true;
        if (!inside) continue;
        const lit = (x - 9) * -0.5 + (y - 9) * -0.7 + (hash(x, y, kind) - 0.5) * 6;
        px(x, y, lit > 3 ? shade(base, 0.35) : lit > -2 ? shade(base, 0.1) : lit > -6 ? base : shade(base, -0.3));
      }
    }
  } else {
    const base = kind === 2 ? '#24583a' : '#2c6440';
    for (let y = 0; y < 21; y++) {
      const tier = y % 7;
      const half = 1 + tier * 1.05 + Math.floor(y / 7) * 1.4;
      for (let x = Math.floor(9 - half); x < Math.ceil(9 + half); x++) {
        px(x, y, x < 9 - half * 0.3 ? shade(base, 0.25) : x > 9 + half * 0.5 ? shade(base, -0.3) : base);
      }
    }
  }
  return outline(c);
}

function rockSprite(kind: number): HTMLCanvasElement {
  const c = makeCanvas(14, 11);
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < 14; x++) {
      const d = Math.hypot((x + 0.5 - 7) / (kind ? 6.5 : 5.5), (y + 0.5 - 6.5) / 4.6);
      if (d > 1) continue;
      const lit = (7 - x) * 0.3 + (6 - y) * 0.6 + (hash(x, y, 9 + kind) - 0.5) * 2;
      g.fillStyle = lit > 2.4 ? '#c9c6d6' : lit > 0 ? '#9894ad' : lit > -2 ? '#77738e' : '#5a566e';
      g.fillRect(x, y, 1, 1);
    }
  }
  return outline(c);
}

export interface TerrainArt {
  canvas: HTMLCanvasElement;
  minimap: HTMLCanvasElement;
}

export function renderTerrain(map: MapData): TerrainArt {
  const { size, tiles } = map;
  const W = size * TILE;
  const canvas = makeCanvas(W, W);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const img = g.createImageData(W, W);
  const d = img.data;

  const flag = (k: number) => {
    const f = new Float32Array(size * size);
    for (let i = 0; i < f.length; i++) f[i] = tiles[i] === k ? 1 : 0;
    return f;
  };
  const dirt = flag(T_DIRT), corrupt = flag(T_CORRUPT), water = flag(T_WATER);
  const land = new Float32Array(size * size);
  for (let i = 0; i < land.length; i++) land[i] = tiles[i] === T_VOID ? 0 : 1;
  const sample = (f: Float32Array, px: number, py: number) => {
    const fx = px / TILE - 0.5, fy = py / TILE - 0.5;
    const ix = Math.max(0, Math.min(size - 2, Math.floor(fx)));
    const iy = Math.max(0, Math.min(size - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - ix)), ty = Math.min(1, Math.max(0, fy - iy));
    const a = f[iy * size + ix], b = f[iy * size + ix + 1], c = f[(iy + 1) * size + ix], e = f[(iy + 1) * size + ix + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
  };

  const landMask = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const n = smooth(x, y, 7, 3) * 0.3 - 0.15;
      landMask[y * W + x] = sample(land, x, y) + n > 0.5 ? 1 : 0;
    }
  }

  const put = (i: number, c: number[]) => { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; };

  for (let x = 0; x < W; x++) {
    let sinceLand = 999;
    for (let y = 0; y < W; y++) {
      const i = (y * W + x) * 4;
      if (landMask[y * W + x]) {
        sinceLand = 0;
      } else {
        sinceLand++;
        const depth = 26 + smooth(x, 0, 9, 5) * 14;
        if (sinceLand <= depth) {
          const band = Math.min(CLIFF.length - 1, Math.floor((sinceLand / depth) * CLIFF.length + (hash(x, y, 4) - 0.5) * 0.8));
          const c = CLIFF[Math.max(0, band)];
          const v = (hash(x >> 1, y, 6) - 0.5) * 14;
          put(i, [c[0] + v, c[1] + v, c[2] + v]);
        } else {
          const s = hash(x, y, 11);
          put(i, s < 0.0015 ? [200, 204, 255] : s < 0.004 ? [90, 95, 138] : VOID);
        }
        continue;
      }
      const big = smooth(x, y, 48, 1);
      const fine = hash(x, y, 2);
      const v = big * 0.55 + fine * 0.45;
      const wv = sample(water, x, y) + (smooth(x, y, 6, 7) - 0.5) * 0.35;
      const cv = sample(corrupt, x, y) + (smooth(x, y, 5, 8) - 0.5) * 0.5;
      const dv = sample(dirt, x, y) + (smooth(x, y, 5, 9) - 0.5) * 0.45;
      if (wv > 0.5) {
        const ripple = Math.sin(x * 0.35 + Math.sin(y * 0.2) * 2 + y * 0.9) > 0.92 && hash(x, y, 12) < 0.6;
        put(i, ripple ? [95, 147, 200] : WATER[Math.min(2, Math.floor(v * 3))]);
      } else if (wv > 0.42) {
        put(i, [168, 216, 240]);
      } else if (cv > 0.5) {
        const crack = Math.abs(smooth(x, y, 6, 13) - 0.5) < 0.018;
        put(i, crack ? (hash(x, y, 14) < 0.5 ? [155, 92, 255] : [192, 139, 255]) : CORRUPT[Math.min(3, Math.floor(v * 4))]);
      } else if (dv > 0.5) {
        put(i, fine < 0.012 ? [184, 165, 138] : DIRT[Math.min(3, Math.floor(v * 4))]);
      } else {
        let c = GRASS[Math.min(3, Math.floor(v * 4))];
        const blade = hash(x, y >> 1, 15);
        if (blade < 0.05) c = GRASS[0];
        else if (blade > 0.985) c = GRASS[3];
        const fl = hash(x, y, 16);
        if (fl < 0.0025) c = FLOWERS[Math.floor(hash(x, y, 17) * 4)];
        put(i, c);
      }
    }
  }
  g.putImageData(img, 0, 0);

  // Trees and rocks, back to front so lower ones overlap.
  const trees = [0, 1, 2, 3].map(treeSprite);
  const rocks = [0, 1].map(rockSprite);
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const k = tiles[ty * size + tx];
      if (k !== T_TREE && k !== T_ROCK) continue;
      const h = hash(tx, ty, 21);
      const ox = Math.round((h - 0.5) * 4);
      g.fillStyle = 'rgba(10,20,10,0.28)';
      g.beginPath();
      g.ellipse(tx * TILE + 8 + ox, ty * TILE + 13, 7, 3, 0, 0, Math.PI * 2);
      g.fill();
      if (k === T_TREE) {
        const s = trees[Math.floor(h * 4)];
        g.drawImage(s, tx * TILE + 8 - s.width / 2 + ox, ty * TILE + 15 - s.height);
      } else {
        const s = rocks[h < 0.5 ? 0 : 1];
        g.drawImage(s, tx * TILE + 8 - s.width / 2 + ox, ty * TILE + 15 - s.height);
      }
    }
  }

  // Minimap: one pixel per tile.
  const minimap = makeCanvas(size, size);
  const mg = minimap.getContext('2d') as CanvasRenderingContext2D;
  const mi = mg.createImageData(size, size);
  const MM: Record<number, number[]> = {
    0: [72, 134, 64], 1: [138, 106, 71], 2: [44, 90, 140], 3: [120, 116, 140], 4: [36, 88, 46], 5: [11, 13, 26], 6: [58, 40, 84],
  };
  for (let i = 0; i < size * size; i++) {
    const c = MM[tiles[i]];
    mi.data[i * 4] = c[0]; mi.data[i * 4 + 1] = c[1]; mi.data[i * 4 + 2] = c[2]; mi.data[i * 4 + 3] = 255;
  }
  mg.putImageData(mi, 0, 0);
  return { canvas, minimap };
}
