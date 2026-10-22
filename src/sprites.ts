// Pixel art, generated in code. Creatures come from tiny palette templates;
// buildings are painted procedurally. Everything gets an automatic dark outline.

import type { BuildingType, EnemyType } from './config.ts';

export const TILE = 16;
const OUTLINE = '#16121f';

type Pal = Record<string, string>;

const PAL: Pal = {
  h: '#ffffff', x: '#16121f',
  g: '#c9c6d6', G: '#9894ad', d: '#66627e',
  w: '#c8925e', W: '#8d5b3a', n: '#5c3a2b',
  e: '#7ccc5a', E: '#4a8f3a',
  r: '#e8504a', R: '#a52e3c',
  o: '#f39a3c', y: '#ffe066', Y: '#e0a030',
  b: '#8fd3ff', B: '#3f84d8', c: '#d4f6ff',
  p: '#a07ad8', P: '#6a46a8',
  s: '#f2c39a', i: '#efe6d2', m: '#dfe3ec', M: '#8f98aa',
};

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  return c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
}

function fromRows(rows: string[], pal: Pal): HTMLCanvasElement {
  const w = Math.max(...rows.map((r) => r.length));
  const c = makeCanvas(w, rows.length);
  const g = ctx2d(c);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]] ?? PAL[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

export function outline(src: HTMLCanvasElement, color = OUTLINE): HTMLCanvasElement {
  const w = src.width + 2, h = src.height + 2;
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.drawImage(src, 1, 1);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const [r, gg, b] = hexRgb(color);
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 40;
  const mark: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) mark.push(y * w + x);
    }
  }
  for (const i of mark) {
    d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function flipX(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const g = ctx2d(c);
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}

export function silhouette(src: HTMLCanvasElement, color = '#ffffff'): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const g = ctx2d(c);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Scale2x (EPX): doubles pixel art while keeping edges smooth. */
function scale2x(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const s = ctx2d(src).getImageData(0, 0, w, h).data;
  const c = makeCanvas(w * 2, h * 2);
  const g = ctx2d(c);
  const out = g.createImageData(w * 2, h * 2);
  const o = out.data;
  const px = (x: number, y: number) => {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    const i = (y * w + x) * 4;
    return (s[i] << 24) | (s[i + 1] << 16) | (s[i + 2] << 8) | s[i + 3];
  };
  const put = (x: number, y: number, v: number) => {
    const i = (y * w * 2 + x) * 4;
    o[i] = (v >>> 24) & 255; o[i + 1] = (v >>> 16) & 255; o[i + 2] = (v >>> 8) & 255; o[i + 3] = v & 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const P = px(x, y), A = px(x, y - 1), B = px(x + 1, y), C = px(x - 1, y), D = px(x, y + 1);
      let e0 = P, e1 = P, e2 = P, e3 = P;
      if (C === A && C !== D && A !== B) e0 = A;
      if (A === B && A !== C && B !== D) e1 = B;
      if (D === C && D !== B && C !== A) e2 = C;
      if (B === D && B !== A && D !== C) e3 = D;
      put(x * 2, y * 2, e0); put(x * 2 + 1, y * 2, e1);
      put(x * 2, y * 2 + 1, e2); put(x * 2 + 1, y * 2 + 1, e3);
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

export function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function shade(hex: string, amt: number): string {
  const [r, g, b] = hexRgb(hex);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

// ------------------------------------------------------------------ creatures

const GRUNT = [
  'E........E',
  'eE.EEEE.Ee',
  '.eeeeeeee.',
  '.eeyeeyee.',
  '.eeeeeeee.',
  '..eiEEie..',
  '.nnEEEEnn.',
  'enWnnnnWne',
  'e.nnnnnn.e',
  '..nn..nn..',
  '..EE..EE..',
];

const RUNNER = [
  'i.......i',
  '.i.rrr.i.',
  '..rrrrr..',
  '.rryryrr.',
  '.rrrrrrr.',
  '..rRRRr..',
  '.r.RRR.r.',
  '...RRR...',
  '..R...R..',
  '.R.....R.',
];

const BRUTE = [
  '....pppppp....',
  '...pppppppp...',
  '..ppyppppypp..',
  '..pppppppppp..',
  '..ppiPPPPipp..',
  '...pppppppp...',
  '.PPPnnnnnnPPP.',
  'PpPnnnnnnnnPpP',
  'pp.nnWWWWnn.pp',
  'pp.nnnnnnnn.pp',
  'Pp..nnnnnn..pP',
  '....PPP.PPP...',
  '....PP...PP...',
  '...PPP...PPP..',
];

const BAT_A = [
  'p..........p',
  'pp...PP...pp',
  'ppp.PPPP.ppp',
  'pppPPyPyPppp',
  '.ppPPPPPPpp.',
  '...PPiiPP...',
  '....PPPP....',
  '.....PP.....',
];

const BAT_B = [
  '............',
  '.....PP.....',
  '....PPPP....',
  '...PPyPyP...',
  '.ppPPPPPPpp.',
  'pppPPiiPPppp',
  'pp..PPPP..pp',
  'p....PP....p',
];

const SPIDER = [
  'n..n.n..n',
  '.n.nnn.n.',
  '..nnrnn..',
  '.nnnnnnn.',
  'n..nnn..n',
  'n.......n',
];

const BUILDER = [
  '...tttt...',
  '..tttttt..',
  '.TTTTTTTT.',
  '..ssssss..',
  '..sxssxs..',
  '..ssssss..',
  '..iiiiii..',
  '.tTiiiiTt.',
  's.tttttt.s',
  '..tTTTTt..',
  '..MM..MM..',
  '..oo..oo..',
];

interface CreatureArt {
  frames: string[][];
  pal: Pal;
  scale: number;
  crown?: boolean;
}

const CREATURES: Record<EnemyType, CreatureArt> = {
  grunt: { frames: [GRUNT], pal: {}, scale: 1 },
  runner: { frames: [RUNNER], pal: {}, scale: 1 },
  brute: { frames: [BRUTE], pal: {}, scale: 1 },
  bat: { frames: [BAT_A, BAT_B], pal: { p: '#7a5aa6', P: '#3e2c5c' }, scale: 1 },
  spider: { frames: [SPIDER], pal: { n: '#2c2236', r: '#ff4a4a' }, scale: 1 },
  ogre: { frames: [BRUTE], pal: { p: '#d08d4e', P: '#8d5a2e', n: '#5a3424', W: '#c9b27a', y: '#ff5a3a' }, scale: 2, crown: true },
  brood: { frames: [SPIDER], pal: { n: '#3b2650', r: '#ff3a5a' }, scale: 4 },
  wraith: { frames: [BAT_A, BAT_B], pal: { p: '#b9c6ff', P: '#6372c4', y: '#ffffff', i: '#dfe6ff' }, scale: 2 },
  golem: { frames: [BRUTE], pal: { p: '#a8a6b6', P: '#6b697c', n: '#4b495a', W: '#7ef0ff', y: '#7ef0ff', i: '#cfcfdd' }, scale: 2 },
  warlock: { frames: [RUNNER], pal: { r: '#8a4ad8', R: '#4a2486', y: '#7affc8', i: '#2a1a40' }, scale: 2, crown: true },
  titan: { frames: [BRUTE], pal: { p: '#7a2230', P: '#3f1020', n: '#24101a', W: '#ff7a2a', y: '#ffb02a', i: '#ffe0a0' }, scale: 4, crown: true },
};

function upscale(c: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  let out = c;
  for (let s = 1; s < scale; s *= 2) out = scale2x(out);
  return out;
}

function addCrown(c: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(c.width, c.height + 4);
  const g = ctx2d(out);
  g.drawImage(c, 0, 4);
  const cx = Math.floor(c.width / 2);
  const rows = ['y.y.y', 'yyyyy', 'YrYrY'];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = PAL[row[x]];
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(cx - 2 + x, y + 1, 1, 1);
    }
  });
  return out;
}

// ------------------------------------------------------------------ buildings

class Painter {
  g: CanvasRenderingContext2D;

  constructor(c: HTMLCanvasElement) {
    this.g = ctx2d(c);
  }

  rect(x: number, y: number, w: number, h: number, col: string): void {
    this.g.fillStyle = col;
    this.g.fillRect(x, y, w, h);
  }

  px(x: number, y: number, col: string): void {
    this.rect(x, y, 1, 1, col);
  }

  /** Shaded brick column, lit from the left. */
  bricks(x0: number, w: number, y0: number, y1: number, col: string, brick = 4): void {
    const light = shade(col, 0.22), dark = shade(col, -0.25), mortar = shade(col, -0.38);
    for (let y = y0; y <= y1; y++) {
      const row = Math.floor((y - y0) / brick);
      for (let x = x0; x < x0 + w; x++) {
        const t = (x - x0) / Math.max(1, w - 1);
        let c = t < 0.22 ? light : t > 0.72 ? dark : col;
        if ((y - y0) % brick === brick - 1) c = mortar;
        else if ((x - x0 + (row % 2) * 3) % 6 === 0) c = mortar;
        this.px(x, y, c);
      }
    }
  }

  /** Cone roof: apex at (cx, y0), widest (half-width hw) at y1. */
  cone(cx: number, y0: number, y1: number, hw: number, col: string): void {
    const light = shade(col, 0.2), dark = shade(col, -0.3), line = shade(col, -0.45);
    for (let y = y0; y <= y1; y++) {
      const k = (y - y0 + 1) / (y1 - y0 + 1);
      const half = Math.max(0.5, hw * k);
      for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
        let c = x < cx - 0.5 ? light : dark;
        if ((y - y0) % 3 === 2) c = line;
        if (Math.abs(x - cx + 0.5) < 0.6 && y < y0 + 2) c = light;
        this.px(x, y, c);
      }
    }
  }

  disc(cx: number, cy: number, r: number, col: string, hi: string): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r) continue;
        const lit = Math.hypot(x + 0.5 - (cx - r * 0.35), y + 0.5 - (cy - r * 0.35)) < r * 0.45;
        this.px(x, y, lit ? hi : d > r - 1.2 ? shade(col, -0.25) : col);
      }
    }
  }
}

const STONE = '#a9a5bd';

function plinth(p: Painter, y: number, w = 14, x = 1, col = '#8e8aa3'): void {
  p.rect(x, y, w, 1, shade(col, 0.3));
  p.bricks(x, w, y + 1, y + 4, col, 2);
}

function drawArrow(team: string): HTMLCanvasElement {
  const c = makeCanvas(16, 30);
  const p = new Painter(c);
  plinth(p, 25);
  p.bricks(4, 8, 11, 25, STONE);
  p.rect(7, 15, 2, 3, OUTLINE);
  p.rect(2, 9, 12, 1, PAL.w);
  p.rect(2, 10, 12, 2, PAL.W);
  for (const x of [3, 6, 9, 12]) p.px(x, 10, PAL.n);
  for (const x of [2, 13]) p.rect(x, 6, 1, 3, PAL.W);
  p.cone(8, 0, 7, 7.5, team);
  p.rect(4, 20, 8, 1, team);
  return c;
}

function drawCannon(team: string): HTMLCanvasElement {
  const c = makeCanvas(16, 26);
  const p = new Painter(c);
  plinth(p, 21, 16, 0);
  p.bricks(2, 12, 9, 21, '#928ea8');
  for (const x of [2, 7, 11]) p.bricks(x, x === 7 ? 2 : 3, 6, 8, '#a4a0b8', 2);
  p.rect(2, 9, 12, 1, shade('#928ea8', 0.3));
  p.disc(8, 13, 3.4, '#2e2a38', '#6a6680');
  p.rect(7, 13, 2, 2, '#0b0a10');
  p.rect(2, 19, 12, 1, team);
  p.px(2, 18, shade(team, 0.3));
  return c;
}

function drawFrost(team: string): HTMLCanvasElement {
  const c = makeCanvas(16, 30);
  const p = new Painter(c);
  plinth(p, 25, 14, 1, '#7f98b0');
  p.bricks(4, 8, 13, 25, '#b5cde0');
  p.rect(3, 11, 10, 2, '#8fb4d0');
  p.rect(3, 11, 10, 1, '#cfe6f6');
  // crystal
  for (let y = 0; y <= 10; y++) {
    const half = y <= 4 ? y * 0.9 + 0.5 : (10 - y) * 0.7 + 0.5;
    for (let x = Math.floor(8 - half); x < Math.ceil(8 + half); x++) {
      p.px(x, y, x < 8 ? '#d4f6ff' : '#7cc8f0');
    }
  }
  p.px(6, 3, '#ffffff');
  p.px(6, 4, '#ffffff');
  p.rect(4, 22, 8, 1, team);
  return c;
}

function drawTesla(team: string): HTMLCanvasElement {
  const c = makeCanvas(16, 30);
  const p = new Painter(c);
  plinth(p, 25, 14, 1, '#757d8f');
  p.rect(1, 25, 14, 1, team);
  p.bricks(6, 4, 9, 25, '#9aa3b6', 30);
  for (const y of [11, 14, 17, 20]) {
    p.rect(4, y, 8, 2, '#c27a3a');
    p.rect(4, y, 8, 1, '#e3a066');
    p.px(11, y + 1, '#7a4420');
  }
  p.disc(8, 5, 4.2, '#b48af0', '#f4e8ff');
  return c;
}

function drawSpikes(team: string): HTMLCanvasElement {
  const c = makeCanvas(16, 16);
  const p = new Painter(c);
  p.rect(2, 4, 12, 10, '#5a4030');
  p.rect(3, 5, 10, 8, '#6e5038');
  for (const [x, y] of [[4, 6], [8, 6], [6, 9], [10, 9], [4, 11], [8, 11]]) {
    p.px(x + 1, y - 2, '#f2f4f8');
    p.rect(x, y - 1, 3, 1, '#c6ccd8');
    p.rect(x, y, 3, 1, '#7d8596');
  }
  p.px(2, 4, team); p.px(13, 4, team); p.px(2, 13, team); p.px(13, 13, team);
  return c;
}

function drawWall(level: number): HTMLCanvasElement {
  const c = makeCanvas(16, 24);
  const p = new Painter(c);
  const top = level === 3 ? '#9c97b0' : '#bdb8cf';
  const face = level === 3 ? '#6f6a86' : '#8a85a0';
  p.rect(0, 0, 16, 10, top);
  p.rect(0, 0, 16, 1, shade(top, 0.25));
  for (const [x, y] of [[3, 3], [10, 2], [6, 6], [13, 7]]) p.px(x, y, shade(top, -0.12));
  p.bricks(0, 16, 10, 23, face);
  if (level >= 2) {
    for (const y of [13, 19]) {
      p.rect(0, y, 16, 1, '#5d6476');
      for (let x = 2; x < 16; x += 5) p.px(x, y, '#c9d0de');
    }
  }
  if (level >= 3) {
    for (let x = 1; x < 16; x += 4) {
      p.px(x + 1, 1, '#e4e8f0');
      p.rect(x, 2, 3, 1, '#9aa2b3');
    }
  }
  return c;
}

function drawCore(team: string): HTMLCanvasElement {
  const c = makeCanvas(48, 72);
  const p = new Painter(c);
  // keep
  p.bricks(13, 22, 16, 48, '#b3afc6');
  p.cone(24, 0, 17, 13, team);
  p.rect(21, 22, 6, 10, team);
  p.rect(21, 22, 6, 1, shade(team, 0.35));
  p.rect(23, 25, 2, 4, '#ffe066');
  p.rect(16, 36, 2, 4, OUTLINE);
  p.rect(30, 36, 2, 4, OUTLINE);
  // corner towers
  for (const x0 of [0, 36]) {
    p.bricks(x0 + 1, 10, 30, 71, '#a19db6');
    p.cone(x0 + 6, 17, 30, 7, team);
    p.rect(x0 + 5, 40, 2, 4, OUTLINE);
    p.rect(x0 + 5, 54, 2, 4, OUTLINE);
  }
  // front wall + walkway + merlons
  p.rect(10, 46, 28, 4, '#cdc9dc');
  for (let x = 10; x < 38; x += 4) p.rect(x, 43, 2, 3, '#bdb8cf');
  p.bricks(10, 28, 50, 71, '#9894ae');
  // gate
  p.rect(19, 57, 10, 15, '#2a2233');
  p.rect(20, 56, 8, 1, '#2a2233');
  p.rect(20, 59, 8, 13, PAL.W);
  for (let x = 21; x < 28; x += 2) p.rect(x, 59, 1, 13, PAL.n);
  p.rect(20, 59, 8, 1, '#3a3044');
  // banners
  p.rect(12, 50, 3, 7, team);
  p.rect(33, 50, 3, 7, team);
  return c;
}

// ------------------------------------------------------------------ registry

export class Sprites {
  private cache = new Map<string, HTMLCanvasElement>();
  private creatureBase = new Map<string, HTMLCanvasElement>();

  enemy(type: EnemyType, frame: number, flip: boolean, flash: boolean): HTMLCanvasElement {
    const art = CREATURES[type];
    const f = frame % art.frames.length;
    const key = `e:${type}:${f}:${flip ? 1 : 0}:${flash ? 1 : 0}`;
    let c = this.cache.get(key);
    if (c) return c;
    const bkey = `${type}:${f}`;
    let base = this.creatureBase.get(bkey);
    if (!base) {
      base = upscale(fromRows(art.frames[f], art.pal), art.scale);
      if (art.crown) base = addCrown(base);
      base = outline(base);
      this.creatureBase.set(bkey, base);
    }
    c = flip ? flipX(base) : base;
    if (flash) c = silhouette(c);
    this.cache.set(key, c);
    return c;
  }

  builder(team: string, flip: boolean): HTMLCanvasElement {
    const key = `bu:${team}:${flip ? 1 : 0}`;
    let c = this.cache.get(key);
    if (c) return c;
    c = outline(fromRows(BUILDER, { t: team, T: shade(team, -0.3) }));
    if (flip) c = flipX(c);
    this.cache.set(key, c);
    return c;
  }

  building(type: BuildingType, team: string, level: number, flash = false): HTMLCanvasElement {
    const lv = type === 'wall' ? level : 1;
    const key = `b:${type}:${team}:${lv}:${flash ? 1 : 0}`;
    let c = this.cache.get(key);
    if (c) return c;
    if (flash) {
      c = silhouette(this.building(type, team, level), '#ffffff');
    } else {
      let raw: HTMLCanvasElement;
      switch (type) {
        case 'arrow': raw = drawArrow(team); break;
        case 'cannon': raw = drawCannon(team); break;
        case 'frost': raw = drawFrost(team); break;
        case 'tesla': raw = drawTesla(team); break;
        case 'spikes': raw = drawSpikes(team); break;
        case 'wall': raw = drawWall(lv); break;
        case 'core': raw = drawCore(team); break;
      }
      c = outline(raw);
    }
    this.cache.set(key, c);
    return c;
  }

  /** Same building tinted, for placement previews and selection glows. */
  tinted(type: BuildingType, team: string, level: number, color: string): HTMLCanvasElement {
    const key = `t:${type}:${team}:${level}:${color}`;
    let c = this.cache.get(key);
    if (c) return c;
    c = silhouette(this.building(type, team, level), color);
    this.cache.set(key, c);
    return c;
  }
}
