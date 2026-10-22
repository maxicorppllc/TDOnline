// Draws the match: terrain, y-sorted buildings and units, projectiles, particles,
// a night-time lighting pass that deepens as the waves go on, and overlays.

import { BUILDINGS, TOTAL_WAVES } from './config.ts';
import type { BuildingType, TowerType } from './config.ts';
import type { Building, Enemy, Game, GameEvent } from './game.ts';
import { Sprites, TILE, makeCanvas } from './sprites.ts';
import { renderTerrain } from './terrain.ts';

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  color: string; size: number; grav: number;
}

interface Ring { x: number; y: number; r: number; life: number; max: number; color: string; width: number }
interface Bolt { pts: number[]; life: number }
interface Floater { x: number; y: number; text: string; life: number; color: string }
interface Flash { x: number; y: number; r: number; life: number; max: number }

export interface ViewState {
  hoverX: number;
  hoverY: number;
  placing: TowerType | null;
  selected: number;
  ghost: boolean;
}

const ZOOMS = [1.5, 2, 2.5, 3, 4, 5];

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  game: Game;
  sprites = new Sprites();
  terrain: HTMLCanvasElement;
  minimapBase: HTMLCanvasElement;
  cam: { x: number; y: number };
  zoomIdx = 3;
  dpr = 1;
  W = 0;
  H = 0;
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private bolts: Bolt[] = [];
  private floaters: Floater[] = [];
  private flashes: Flash[] = [];
  private shake = 0;
  private dark = 0;
  private light: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private portal: HTMLCanvasElement;
  private portalCtx: CanvasRenderingContext2D;
  private portalImg: ImageData;
  private time = 0;
  /** Banner events are handed to the UI. */
  onBanner: ((e: Extract<GameEvent, { k: 'banner' }>) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, game: Game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.game = game;
    const art = renderTerrain(game.map);
    this.terrain = art.canvas;
    this.minimapBase = art.minimap;
    const h = game.human;
    const c = h ? game.coreCenter(h.base) : { x: game.map.center, y: game.map.center };
    this.cam = { x: c.x, y: c.y - 2 };
    if (!h) this.zoomIdx = 1;
    this.light = makeCanvas(4, 4);
    this.lctx = this.light.getContext('2d') as CanvasRenderingContext2D;
    this.portal = makeCanvas(96, 96);
    this.portalCtx = this.portal.getContext('2d') as CanvasRenderingContext2D;
    this.portalImg = this.portalCtx.createImageData(96, 96);
  }

  get zoom(): number {
    return ZOOMS[this.zoomIdx];
  }

  /** Screen pixels (device) per art pixel. */
  get scale(): number {
    return this.zoom * this.dpr;
  }

  zoomAt(dir: number, sx: number, sy: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, this.zoomIdx + dir));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCam();
  }

  clampCam(): void {
    const s = this.game.size;
    this.cam.x = Math.max(2, Math.min(s - 2, this.cam.x));
    this.cam.y = Math.max(2, Math.min(s - 2, this.cam.y));
  }

  private origin(): { ox: number; oy: number } {
    const S = this.scale;
    let ox = Math.round(this.W / 2 - this.cam.x * TILE * S);
    let oy = Math.round(this.H / 2 - this.cam.y * TILE * S);
    if (this.shake > 0.1) {
      ox += Math.round((Math.random() - 0.5) * this.shake * this.dpr * 2);
      oy += Math.round((Math.random() - 0.5) * this.shake * this.dpr * 2);
    }
    return { ox, oy };
  }

  /** CSS pixel position -> world tile coordinates. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const S = this.scale;
    const ox = this.W / 2 - this.cam.x * TILE * S;
    const oy = this.H / 2 - this.cam.y * TILE * S;
    return { x: (sx * this.dpr - ox) / S / TILE, y: (sy * this.dpr - oy) / S / TILE };
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (w === this.W && h === this.H && dpr === this.dpr) return;
    this.dpr = dpr;
    this.W = this.canvas.width = w;
    this.H = this.canvas.height = h;
    this.light.width = Math.ceil(w / 2);
    this.light.height = Math.ceil(h / 2);
  }

  // ---------------------------------------------------------------- effects

  private burst(x: number, y: number, n: number, colors: string[], speed = 3, up = 4, size = 1): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x, y, z: 4 + Math.random() * 4,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6, vz: up * (0.5 + Math.random()),
        life: 0.4 + Math.random() * 0.5, max: 0.9, color: colors[i % colors.length], size, grav: 18,
      });
    }
  }

  private consume(): void {
    const g = this.game;
    for (const e of g.events) {
      switch (e.k) {
        case 'hit':
          this.burst(e.x, e.y, 3, [e.color], 2, 3);
          break;
        case 'die': {
          const cols = DEATH_COLORS[e.type] ?? ['#ccc'];
          this.burst(e.x, e.y, e.boss ? 60 : 10, cols, e.boss ? 6 : 3, e.boss ? 9 : 5, e.boss ? 2 : 1);
          if (e.boss) {
            this.flashes.push({ x: e.x, y: e.y, r: 7, life: 0.6, max: 0.6 });
            this.rings.push({ x: e.x, y: e.y, r: 4, life: 0.6, max: 0.6, color: '#ffd86b', width: 2 });
          }
          break;
        }
        case 'bdie':
          this.burst(e.x, e.y, e.w > 1 ? 70 : 16, ['#9894ad', '#66627e', '#c9c6d6', '#5c3a2b'], e.w > 1 ? 7 : 4, 6, e.w > 1 ? 2 : 1);
          this.rings.push({ x: e.x, y: e.y, r: e.w * 1.2, life: 0.4, max: 0.4, color: 'rgba(200,190,220,0.8)', width: 1 });
          break;
        case 'built':
          this.burst(e.x, e.y, 8, ['#ffe066', '#fff6c0'], 2, 6);
          break;
        case 'bolt':
          this.bolts.push({ pts: e.pts, life: 0.16 });
          break;
        case 'frost':
          if (e.r < 0) this.rings.push({ x: e.x, y: e.y, r: -e.r, life: 0.5, max: 0.5, color: '#7affc8', width: 1 });
          else this.rings.push({ x: e.x, y: e.y, r: e.r, life: 0.4, max: 0.4, color: '#bfefff', width: 1 });
          break;
        case 'boom':
          this.rings.push({ x: e.x, y: e.y, r: e.r, life: 0.25, max: 0.25, color: '#ffb35a', width: 2 });
          this.burst(e.x, e.y, 10, ['#ffb35a', '#ffe066', '#6a5a5a'], 3, 5);
          this.flashes.push({ x: e.x, y: e.y, r: 2.5, life: 0.2, max: 0.2 });
          break;
        case 'gold':
          this.floaters.push({ x: e.x, y: e.y - 0.6, text: `+${e.amount}`, life: 0.9, color: '#ffd86b' });
          break;
        case 'shock':
          this.rings.push({ x: e.x, y: e.y, r: e.r, life: 0.45, max: 0.45, color: '#9ff0ff', width: 3 });
          this.burst(e.x, e.y, 30, ['#9ff0ff', '#ffffff'], 6, 4);
          this.flashes.push({ x: e.x, y: e.y, r: 4, life: 0.3, max: 0.3 });
          break;
        case 'heal':
          this.burst(e.x, e.y, 12, ['#7affa0', '#d0ffe0'], 1.5, 8);
          break;
        case 'spawn':
          this.burst(e.x, e.y, 30, ['#b07cff', '#f0d8ff'], 5, 6, 2);
          this.flashes.push({ x: e.x, y: e.y, r: 5, life: 0.5, max: 0.5 });
          break;
        case 'shake':
          this.shake = Math.max(this.shake, e.amt);
          break;
        case 'banner':
          this.onBanner?.(e);
          break;
        case 'upgrade':
          this.burst(e.x, e.y, 16, ['#ffd86b', '#ffffff'], 2.5, 7);
          this.rings.push({ x: e.x, y: e.y, r: 1.2, life: 0.4, max: 0.4, color: '#ffd86b', width: 1 });
          break;
      }
    }
    g.events.length = 0;
  }

  private stepFx(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 18);
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vz -= p.grav * dt;
      p.z = Math.max(0, p.z + p.vz * dt);
      if (p.z === 0) { p.vx *= 0.8; p.vy *= 0.8; }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const b of this.bolts) b.life -= dt;
    this.bolts = this.bolts.filter((b) => b.life > 0);
    for (const f of this.floaters) { f.life -= dt; f.y -= dt * 1.2; }
    this.floaters = this.floaters.filter((f) => f.life > 0);
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter((f) => f.life > 0);
  }

  // ---------------------------------------------------------------- render

  render(dt: number, view: ViewState): void {
    this.time += dt;
    this.resize();
    this.consume();
    this.stepFx(dt);
    const g = this.game;
    const ctx = this.ctx;
    const S = this.scale;
    const { ox, oy } = this.origin();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0b0d1a';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.setTransform(S, 0, 0, S, ox, oy);
    ctx.drawImage(this.terrain, 0, 0);

    // visible tile bounds
    const tl = { x: -ox / S / TILE, y: -oy / S / TILE };
    const br = { x: (this.W - ox) / S / TILE, y: (this.H - oy) / S / TILE };
    const vis = (x: number, y: number, m = 3) => x > tl.x - m && x < br.x + m && y > tl.y - m && y < br.y + m * 2;

    this.drawPortal(ctx);

    // ground decals
    const sel = view.selected ? g.buildings.get(view.selected) : undefined;
    if (sel && BUILDINGS[sel.type].range > 0) this.rangeCircle(sel.tx + sel.w / 2, sel.ty + sel.w / 2, g.stat(sel).range, 'rgba(255,255,255,0.55)');
    if (view.placing) this.drawGrid(view.hoverX, view.hoverY);
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      ctx.globalAlpha = Math.min(1, (r.life / r.max) * 1.5);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.ellipse(r.x * TILE, r.y * TILE, Math.max(0.5, r.r * TILE * (0.3 + 0.7 * k)), Math.max(0.5, r.r * TILE * (0.3 + 0.7 * k) * 0.75), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // y-sorted world objects
    const items: { y: number; draw: () => void }[] = [];
    for (const b of g.buildings.values()) {
      if (!vis(b.tx, b.ty)) continue;
      items.push({ y: b.ty + b.w, draw: () => this.drawBuilding(b, b.id === view.selected) });
    }
    for (const e of g.enemies) {
      if (!vis(e.x, e.y)) continue;
      items.push({ y: e.y + (e.def.flying ? 2 : 0), draw: () => this.drawEnemy(e) });
    }
    for (const p of g.players) {
      const bu = p.builder;
      if (bu.dead || !p.alive || !vis(bu.x, bu.y)) continue;
      items.push({
        y: bu.y + 0.4,
        draw: () => {
          const s = this.sprites.builder(p.color, bu.facing < 0);
          const hover = Math.round(Math.sin(this.time * 5 + p.id) * 1.2);
          this.shadow(bu.x, bu.y + 0.15, 4);
          ctx.drawImage(s, Math.round(bu.x * TILE - s.width / 2), Math.round(bu.y * TILE - s.height - 3 + hover));
          if (bu.working && Math.random() < 0.25) this.burst(bu.x + bu.facing * 0.4, bu.y - 0.3, 2, ['#ffe066', '#ffffff'], 2, 3);
          if (p.id === g.humanId) {
            ctx.fillStyle = '#ffd86b';
            const ay = Math.round(bu.y * TILE - s.height - 7 + hover);
            ctx.fillRect(Math.round(bu.x * TILE) - 1, ay, 3, 1);
            ctx.fillRect(Math.round(bu.x * TILE), ay + 1, 1, 1);
          }
          if (bu.hp < bu.maxHp) this.bar(bu.x, bu.y * TILE - s.height - 5, 10, bu.hp / bu.maxHp, '#7aff8a');
        },
      });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    // projectiles
    for (const pr of g.projectiles) {
      if (!vis(pr.x, pr.y)) continue;
      if (pr.kind === 'arrow') {
        const a = Math.atan2(pr.ty - pr.y, pr.tx - pr.x);
        ctx.strokeStyle = '#f2e6c8';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pr.x * TILE, pr.y * TILE - 6);
        ctx.lineTo(pr.x * TILE - Math.cos(a) * 5, pr.y * TILE - 6 - Math.sin(a) * 5);
        ctx.stroke();
      } else if (pr.kind === 'spark') {
        ctx.fillStyle = '#fff3b0';
        ctx.fillRect(Math.round(pr.x * TILE) - 1, Math.round(pr.y * TILE) - 7, 2, 2);
      } else {
        const f = pr.t / pr.dur;
        const z = Math.sin(f * Math.PI) * (pr.kind === 'boulder' ? 26 : 18);
        this.shadow(pr.x, pr.y, pr.kind === 'boulder' ? 4 : 2);
        ctx.fillStyle = pr.kind === 'boulder' ? '#8d8a9e' : '#2a2633';
        const r = pr.kind === 'boulder' ? 3 : 2;
        ctx.fillRect(Math.round(pr.x * TILE) - r, Math.round(pr.y * TILE - z) - r - 4, r * 2, r * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(Math.round(pr.x * TILE) - r, Math.round(pr.y * TILE - z) - r - 4, 1, 1);
      }
    }

    // particles
    for (const p of this.particles) {
      if (!vis(p.x, p.y)) continue;
      ctx.globalAlpha = Math.min(1, p.life * 3);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x * TILE), Math.round(p.y * TILE - p.z), p.size, p.size);
    }
    ctx.globalAlpha = 1;

    this.drawLighting(ox, oy, S);

    // additive glows on top of the darkness
    ctx.setTransform(S, 0, 0, S, ox, oy);
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.bolts) {
      ctx.strokeStyle = `rgba(210,170,255,${b.life / 0.16})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < b.pts.length; i += 2) {
        const x = b.pts[i] * TILE, y = b.pts[i + 1] * TILE - 4;
        if (i === 0) ctx.moveTo(x, y);
        else {
          const px = b.pts[i - 2] * TILE, py = b.pts[i - 1] * TILE - 4;
          ctx.lineTo((px + x) / 2 + (Math.random() - 0.5) * 6, (py + y) / 2 + (Math.random() - 0.5) * 6);
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    for (const f of this.flashes) {
      const a = f.life / f.max;
      const grd = ctx.createRadialGradient(f.x * TILE, f.y * TILE, 0, f.x * TILE, f.y * TILE, f.r * TILE);
      grd.addColorStop(0, `rgba(255,220,160,${0.7 * a})`);
      grd.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = grd;
      ctx.fillRect((f.x - f.r) * TILE, (f.y - f.r) * TILE, f.r * 2 * TILE, f.r * 2 * TILE);
    }
    for (const b of g.buildings.values()) {
      if (!b.complete || (b.type !== 'tesla' && b.type !== 'frost') || !vis(b.tx, b.ty)) continue;
      const pulse = 0.55 + Math.sin(this.time * 4 + b.id) * 0.15;
      this.glow(b.tx + 0.5, b.ty + 0.5 - (b.type === 'tesla' ? 1.45 : 1.3), 0.9, b.type === 'tesla' ? `rgba(190,140,255,${pulse})` : `rgba(140,220,255,${pulse})`);
    }
    ctx.globalCompositeOperation = 'source-over';

    // overlays
    for (const e of g.enemies) {
      if (!vis(e.x, e.y)) continue;
      const s = this.sprites.enemy(e.type, 0, false, false);
      const top = e.y * TILE - s.height - (e.def.flying ? 10 : 0) - 2;
      if (e.def.boss) {
        this.bar(e.x, top, 28, e.hp / e.maxHp, '#ff4a5a', true);
      } else if (e.hp < e.maxHp) {
        this.bar(e.x, top, 8, e.hp / e.maxHp, '#ff5a5a');
      }
    }
    for (const b of g.buildings.values()) {
      if (!vis(b.tx, b.ty)) continue;
      if (b.started && b.hp < b.maxHp && b.crumble <= 0) {
        this.bar(b.tx + b.w / 2, b.ty * TILE - (b.w === 3 ? 26 : 16), b.w === 3 ? 30 : 10, b.hp / b.maxHp, b.complete ? '#7aff8a' : '#ffd86b');
      }
    }
    for (const p of g.pings) {
      const k = (p.t % 1);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 1 - k;
      ctx.beginPath();
      ctx.arc(p.x * TILE, p.y * TILE, 4 + k * 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x * TILE) - 1, Math.round(p.y * TILE) - 14, 2, 6);
      ctx.fillRect(Math.round(p.x * TILE) - 1, Math.round(p.y * TILE) - 6, 2, 2);
    }
    if (view.placing) this.drawGhost(view);

    // screen-space text
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(11 * this.dpr)}px "Pixelify Sans", monospace`;
    for (const e of g.enemies) {
      if (!e.def.boss || !vis(e.x, e.y)) continue;
      const s = this.sprites.enemy(e.type, 0, false, false);
      const sx = ox + e.x * TILE * S, sy = oy + (e.y * TILE - s.height - (e.def.flying ? 10 : 0) - 7) * S;
      this.text(e.def.name, sx, sy, '#ffd0d6');
    }
    ctx.font = `bold ${Math.round(13 * this.dpr)}px "Pixelify Sans", monospace`;
    for (const f of this.floaters) {
      ctx.globalAlpha = Math.min(1, f.life * 2);
      this.text(f.text, ox + f.x * TILE * S, oy + f.y * TILE * S, f.color);
    }
    ctx.globalAlpha = 1;
    ctx.font = `${Math.round(11 * this.dpr)}px "Pixelify Sans", monospace`;
    for (const p of g.players) {
      if (!vis(this.game.map.bases[p.base].tx, this.game.map.bases[p.base].ty, 6)) continue;
      const c = g.coreCenter(p.base);
      this.text(p.alive ? p.name : `${p.name} (fallen)`, ox + c.x * TILE * S, oy + (c.y * TILE + 30) * S, p.alive ? p.color : '#8a8598');
    }
  }

  private text(t: string, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(10,8,20,0.85)';
    ctx.fillText(t, x + this.dpr, y + this.dpr);
    ctx.fillStyle = color;
    ctx.fillText(t, x, y);
  }

  private shadow(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(8,12,20,0.3)';
    ctx.beginPath();
    ctx.ellipse(x * TILE, y * TILE, r, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private bar(x: number, topY: number, w: number, f: number, color: string, big = false): void {
    const ctx = this.ctx;
    const h = big ? 3 : 2;
    const x0 = Math.round(x * TILE - w / 2), y0 = Math.round(topY);
    ctx.fillStyle = '#16121f';
    ctx.fillRect(x0 - 1, y0 - 1, w + 2, h + 2);
    ctx.fillStyle = '#3a2f44';
    ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, Math.max(0, Math.round(w * Math.max(0, Math.min(1, f)))), h);
  }

  private glow(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    const grd = ctx.createRadialGradient(x * TILE, y * TILE, 0, x * TILE, y * TILE, r * TILE);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect((x - r) * TILE, (y - r) * TILE, r * 2 * TILE, r * 2 * TILE);
  }

  private rangeCircle(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x * TILE, y * TILE, r * TILE, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color.replace(/[\d.]+\)$/, '0.06)');
    ctx.fill();
  }

  private drawGrid(hx: number, hy: number): void {
    const ctx = this.ctx;
    const tx = Math.floor(hx), ty = Math.floor(hy);
    for (let y = ty - 4; y <= ty + 4; y++) {
      for (let x = tx - 4; x <= tx + 4; x++) {
        const d = Math.hypot(x - tx, y - ty);
        if (d > 4.5) continue;
        ctx.strokeStyle = `rgba(255,255,255,${0.14 * (1 - d / 4.5)})`;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x * TILE + 0.25, y * TILE + 0.25, TILE - 0.5, TILE - 0.5);
      }
    }
  }

  private drawGhost(view: ViewState): void {
    const g = this.game;
    const h = g.human;
    if (!h || !view.placing) return;
    const ctx = this.ctx;
    const tx = Math.floor(view.hoverX), ty = Math.floor(view.hoverY);
    const ok = g.canPlace(h.id, tx, ty) && h.gold >= BUILDINGS[view.placing].cost;
    const def = BUILDINGS[view.placing];
    if (def.range > 0) this.rangeCircle(tx + 0.5, ty + 0.5, def.range, ok ? 'rgba(255,255,255,0.5)' : 'rgba(255,90,90,0.5)');
    const s = this.sprites.building(view.placing, h.color, 1);
    ctx.globalAlpha = 0.65;
    ctx.drawImage(s, tx * TILE + 8 - s.width / 2, (ty + 1) * TILE - s.height + 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = ok ? 'rgba(120,255,140,0.25)' : 'rgba(255,70,70,0.4)';
    ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
  }

  private drawBuilding(b: Building, selected: boolean): void {
    const ctx = this.ctx;
    const g = this.game;
    const team = g.players[b.owner].color;
    const s = this.sprites.building(b.type, team, b.level);
    const x = Math.round(b.tx * TILE + (b.w * TILE) / 2 - s.width / 2);
    let y = (b.ty + b.w) * TILE - s.height + 1;
    let jx = 0;
    if (b.crumble > 0) jx = Math.round((Math.random() - 0.5) * 2);
    if (b.type !== 'spikes' && b.type !== 'wall') this.shadow(b.tx + b.w / 2 + 0.15, b.ty + b.w - 0.2, b.w * 6);
    if (!b.started) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(s, x, y);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,230,140,0.7)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 0.75;
      ctx.strokeRect(b.tx * TILE + 1, b.ty * TILE + 1, TILE - 2, TILE - 2);
      ctx.setLineDash([]);
      return;
    }
    if (!b.complete) {
      const visible = Math.max(2, Math.round(s.height * b.progress));
      ctx.globalAlpha = 0.3;
      ctx.drawImage(s, x, y);
      ctx.globalAlpha = 1;
      ctx.drawImage(s, 0, s.height - visible, s.width, visible, x, y + s.height - visible, s.width, visible);
      ctx.fillStyle = '#c8925e';
      for (let k = 0; k < 3; k++) ctx.fillRect(x + 2 + k * 6, y + s.height - visible - 1, 1, visible);
      return;
    }
    if (selected) {
      const glow = this.sprites.tinted(b.type, team, b.level, '#ffffff');
      ctx.globalAlpha = 0.5 + Math.sin(this.time * 6) * 0.3;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(glow, x + dx, y + dy);
      ctx.globalAlpha = 1;
    }
    if (b.crumble > 0) ctx.globalAlpha = 0.55 + Math.random() * 0.3;
    ctx.drawImage(b.flash > 0 ? this.sprites.building(b.type, team, b.level, true) : s, x + jx, y);
    ctx.globalAlpha = 1;
    if (b.level > 1 && b.type !== 'wall') {
      ctx.fillStyle = '#ffd86b';
      for (let k = 0; k < b.level - 1; k++) ctx.fillRect(b.tx * TILE + 11 - k * 4, (b.ty + 1) * TILE - 3, 3, 2);
    }
  }

  private drawEnemy(e: Enemy): void {
    const ctx = this.ctx;
    const frame = e.type === 'bat' || e.type === 'wraith' ? Math.floor(e.anim * 8) % 2 : 0;
    const s = this.sprites.enemy(e.type, frame, e.facing < 0, e.hitFlash > 0);
    const bob = e.def.flying ? Math.round(Math.sin(e.anim * 6) * 2) : (Math.floor(e.anim * 7) % 2);
    const lunge = e.attacking && Math.floor(e.anim * 4) % 2 === 0 ? e.facing * 1 : 0;
    const z = e.def.flying ? 10 : 0;
    this.shadow(e.x, e.y + 0.05, Math.max(3, s.width * 0.35));
    ctx.drawImage(s, Math.round(e.x * TILE - s.width / 2 + lunge), Math.round(e.y * TILE - s.height + 2 - z - bob));
    if (e.slowT > 0) {
      ctx.fillStyle = 'rgba(170,230,255,0.9)';
      ctx.fillRect(Math.round(e.x * TILE) - 1, Math.round(e.y * TILE - s.height - z - 1), 2, 1);
    }
  }

  private drawPortal(ctx: CanvasRenderingContext2D): void {
    const c = this.game.map.center;
    const d = this.portalImg.data;
    const t = this.time;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        const dx = x + 0.5 - 48, dy = (y + 0.5 - 48) * 1.35;
        const r = Math.hypot(dx, dy);
        const i = (y * 96 + x) * 4;
        if (r > 40) { d[i + 3] = 0; continue; }
        const a = Math.atan2(dy, dx);
        const sw = Math.sin(a * 3 + r * 0.22 - t * 2.4) + Math.sin(a * 5 - r * 0.15 + t * 1.3) * 0.5;
        const k = r / 40;
        let col: number[];
        if (k > 0.9) col = [40, 22, 70];
        else if (sw > 1.3 - k * 0.7) col = [240, 216, 255];
        else if (sw > 0.1) col = [176, 110, 255];
        else if (sw > -0.6) col = [104, 50, 190];
        else col = [52, 22, 104];
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
      }
    }
    this.portalCtx.putImageData(this.portalImg, 0, 0);
    ctx.drawImage(this.portal, c * TILE - 48, c * TILE - 48);
    // standing stones around the rim
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.2;
      const sx = c * TILE + Math.cos(a) * 46, sy = c * TILE + Math.sin(a) * 34;
      ctx.fillStyle = '#16121f';
      ctx.fillRect(Math.round(sx) - 3, Math.round(sy) - 12, 7, 13);
      ctx.fillStyle = '#5d5872';
      ctx.fillRect(Math.round(sx) - 2, Math.round(sy) - 11, 5, 11);
      ctx.fillStyle = '#8f8aa6';
      ctx.fillRect(Math.round(sx) - 2, Math.round(sy) - 11, 2, 11);
      ctx.fillStyle = (Math.floor(t * 2 + k) % 4 === 0) ? '#e0b8ff' : '#9b5cff';
      ctx.fillRect(Math.round(sx), Math.round(sy) - 8, 1, 2);
    }
  }

  private drawLighting(ox: number, oy: number, S: number): void {
    const g = this.game;
    const target = g.phase === 'build' ? 0 : Math.min(1, Math.max(0, (g.wave - 2) / 16)) * 0.62;
    this.dark += (target - this.dark) * Math.min(1, 0.02);
    if (this.dark < 0.02) return;
    const l = this.lctx;
    const lw = this.light.width, lh = this.light.height;
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, lw, lh);
    l.fillStyle = `rgba(10,8,34,${this.dark})`;
    l.fillRect(0, 0, lw, lh);
    l.globalCompositeOperation = 'destination-out';
    const k = S * TILE / 2;
    const hole = (x: number, y: number, r: number, a = 1) => {
      const sx = (ox + x * TILE * S) / 2, sy = (oy + y * TILE * S) / 2, rr = r * k;
      if (sx + rr < 0 || sy + rr < 0 || sx - rr > lw || sy - rr > lh) return;
      const grd = l.createRadialGradient(sx, sy, 0, sx, sy, rr);
      grd.addColorStop(0, `rgba(0,0,0,${a})`);
      grd.addColorStop(0.5, `rgba(0,0,0,${a * 0.6})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = grd;
      l.fillRect(sx - rr, sy - rr, rr * 2, rr * 2);
    };
    hole(g.map.center, g.map.center, 9, 0.9);
    for (const b of g.buildings.values()) {
      if (!b.complete) continue;
      if (b.type === 'core') hole(b.tx + 1.5, b.ty + 1.5, 6.5);
      else if (b.type !== 'wall' && b.type !== 'spikes') hole(b.tx + 0.5, b.ty, b.type === 'tesla' || b.type === 'frost' ? 3.4 : 2.6, 0.85);
    }
    for (const p of g.players) if (p.alive && !p.builder.dead) hole(p.builder.x, p.builder.y, 2.4, 0.8);
    for (const f of this.flashes) hole(f.x, f.y, f.r, f.life / f.max);
    for (const pr of g.projectiles) hole(pr.x, pr.y, 0.9, 0.6);
    for (const b of this.bolts) for (let i = 0; i < b.pts.length; i += 2) hole(b.pts[i], b.pts[i + 1], 1.4, 0.8);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.light, 0, 0, this.W, this.H);
    ctx.imageSmoothingEnabled = false;
  }

  /** Small one-off icon for the build bar. */
  icon(type: BuildingType, team: string): HTMLCanvasElement {
    return this.sprites.building(type, team, 1);
  }

  darkness(): number {
    return this.dark / 0.62;
  }

  static wavesLeft(g: Game): number {
    return TOTAL_WAVES - g.wave;
  }
}

const DEATH_COLORS: Record<string, string[]> = {
  grunt: ['#7ccc5a', '#4a8f3a', '#5c3a2b'],
  runner: ['#e8504a', '#a52e3c'],
  brute: ['#a07ad8', '#6a46a8', '#5c3a2b'],
  bat: ['#7a5aa6', '#3e2c5c'],
  spider: ['#2c2236', '#ff4a4a'],
  ogre: ['#d08d4e', '#8d5a2e', '#ffe066'],
  brood: ['#3b2650', '#ff3a5a', '#7a5aa6'],
  wraith: ['#b9c6ff', '#ffffff', '#6372c4'],
  golem: ['#a8a6b6', '#6b697c', '#7ef0ff'],
  warlock: ['#8a4ad8', '#7affc8', '#ffe066'],
  titan: ['#7a2230', '#ff7a2a', '#ffb02a', '#ffe066'],
};
