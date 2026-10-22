// The match simulation. No DOM in here: the same code can later run on a server.

import {
  BUILD_PHASE, BUILDINGS, BOSS_BLURB, BOSS_WAVES, BOT_NAMES, ENEMIES, FALLEN_SHARE, LEVEL_DMG, LEVEL_HP,
  LEVEL_RANGE, MAX_LEVEL, SELL_REFUND, START_GOLD, TEAM_COLORS, TOTAL_WAVES, TOWER_TYPES, WAVE_INTERVAL,
  dmgMul, hpMul, upgradeCost, waveIncome, waveSpec,
} from './config.ts';
import type { BuildingType, EnemyDef, EnemyType, TowerType } from './config.ts';
import { Rng } from './rng.ts';
import { atan2, cos, hypot, sin } from './dmath.ts';
import { PORTAL_CLEAR, generateMap, isBuildableKind, isWalkableKind } from './map.ts';
import type { MapData } from './map.ts';
import { computeField, nextStep } from './pathing.ts';
import type { PathGrid } from './pathing.ts';
import { BotBrain } from './bots.ts';

export interface Builder {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  respawn: number;
  moveTo: { x: number; y: number } | null;
  targetBp: number;
  facing: number;
  working: boolean;
  moving: boolean;
}

export interface Player {
  id: number;
  name: string;
  color: string;
  isBot: boolean;
  base: number;
  alive: boolean;
  gold: number;
  coreId: number;
  kills: number;
  diedWave: number;
  builder: Builder;
  abilityCd: number;
  ghostCd: number;
  brain: BotBrain | null;
  ready: boolean;
  warned: number;
  thankedAt: number;
}

export interface Building {
  id: number;
  type: BuildingType;
  owner: number;
  tx: number;
  ty: number;
  w: number;
  hp: number;
  maxHp: number;
  level: number;
  started: boolean;
  complete: boolean;
  progress: number;
  cd: number;
  invested: number;
  crumble: number;
  aimX: number;
  aimY: number;
  flash: number;
}

export interface Enemy {
  id: number;
  type: EnemyType;
  def: EnemyDef;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  target: number;
  ox: number;
  oy: number;
  atkCd: number;
  slowT: number;
  slowAmt: number;
  facing: number;
  abilityCd: number;
  dead: boolean;
  hitFlash: number;
  anim: number;
  attacking: boolean;
  dmg: number;
}

export interface Projectile {
  kind: 'arrow' | 'ball' | 'boulder' | 'spark';
  x: number;
  y: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  speed: number;
  damage: number;
  splash: number;
  owner: number;
  target: Enemy | null;
  building: Building | null;
  done: boolean;
}

export type GameEvent =
  | { k: 'hit'; x: number; y: number; color: string }
  | { k: 'die'; x: number; y: number; type: EnemyType; boss: boolean }
  | { k: 'bdie'; x: number; y: number; w: number; type: BuildingType }
  | { k: 'built'; x: number; y: number; owner: number }
  | { k: 'bolt'; pts: number[] }
  | { k: 'frost'; x: number; y: number; r: number }
  | { k: 'boom'; x: number; y: number; r: number }
  | { k: 'gold'; x: number; y: number; amount: number }
  | { k: 'shock'; x: number; y: number; r: number }
  | { k: 'heal'; x: number; y: number }
  | { k: 'spawn'; x: number; y: number; boss: boolean }
  | { k: 'shake'; amt: number }
  | { k: 'banner'; text: string; sub: string; style: 'wave' | 'boss' | 'bad' | 'good' }
  | { k: 'upgrade'; x: number; y: number };

export interface ChatMsg {
  name: string;
  color: string;
  text: string;
  system: boolean;
}

export interface Ping {
  x: number;
  y: number;
  t: number;
  color: string;
}

export interface MatchResult {
  victory: boolean;
  wave: number;
  survivors: number;
  total: number;
}

export interface PlayerResult {
  survived: boolean;
  diedWave: number;
  kills: number;
  shards: number;
}

export interface GameOptions {
  players: number;
  /** Names of the human players; every other seat is a bot. */
  humans: string[];
  seed: number;
  buildPhase?: number;
}

/**
 * Everything a player can do. Online, these travel through the server and are
 * applied on the same tick on every machine, which keeps all copies of the match identical.
 */
export type Command =
  | { k: 'place'; type: TowerType; x: number; y: number }
  | { k: 'sell'; id: number }
  | { k: 'upgrade'; id: number }
  | { k: 'move'; x: number; y: number }
  | { k: 'ability' }
  | { k: 'ghost'; id: number }
  | { k: 'ping'; x: number; y: number }
  | { k: 'chat'; text: string }
  | { k: 'ready' }
  /** Server only: a disconnected player's seat is handed to a bot, or back. */
  | { k: 'bot'; on: boolean };

const CORE_COST = 120;
const BUILDER_SPEED = 5;
const BUILDER_HP = 100;
const ABILITY_CD = 25;
const GHOST_CD = 4;

export class Game {
  rng: Rng;
  map: MapData;
  size: number;
  grid: PathGrid;
  bAt: Int32Array;
  players: Player[] = [];
  /** Base index -> player id. */
  baseOwner: number[] = [];
  buildings = new Map<number, Building>();
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  events: GameEvent[] = [];
  chat: ChatMsg[] = [];
  pings: Ping[] = [];
  fields: Float32Array[] = [];
  fieldDirty: boolean[] = [];
  /** Sim time each field was last recomputed. */
  fieldAge: number[] = [];
  phase: 'build' | 'waves' | 'over' = 'build';
  time = 0;
  phaseTime: number;
  wave = 0;
  nextWaveIn = 0;
  spawnQueue: { t: number; type: EnemyType; base: number }[] = [];
  pendingChat: { t: number; pid: number; text: string }[] = [];
  /** Player id for each entry of opts.humans. */
  humanPids: number[] = [];
  /**
   * The player whose screen this is (-1 for spectators and the server). Only
   * decides which cosmetic events get emitted, never the simulation itself, so
   * every machine can run the same match with a different viewer.
   */
  viewerId = -1;
  opts: GameOptions;
  tick = 0;
  result: MatchResult | null = null;
  nextId = 1;

  // Spatial hash over enemies, rebuilt each tick.
  private cell = 3;
  private cw: number;
  private heads: Int32Array;
  private links: Int32Array = new Int32Array(1024);

  constructor(opts: GameOptions) {
    this.rng = new Rng(opts.seed);
    this.map = generateMap(opts.players, opts.seed);
    const size = (this.size = this.map.size);
    this.bAt = new Int32Array(size * size);
    const walk = new Uint8Array(size * size);
    const cost = new Float32Array(size * size);
    const open = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) {
      walk[i] = isWalkableKind(this.map.tiles[i]) ? 1 : 0;
      cost[i] = 1;
      open[i] = walk[i];
    }
    this.grid = { size, walk, cost, open };
    this.cw = Math.ceil(size / this.cell);
    this.heads = new Int32Array(this.cw * this.cw);
    this.phaseTime = opts.buildPhase ?? BUILD_PHASE;

    const n = opts.players;
    this.opts = { ...opts, buildPhase: this.phaseTime };
    const shuffle = <T>(arr: T[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.rng.int(0, i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    const names = shuffle(BOT_NAMES.filter((b) => !opts.humans.includes(b)));
    // Humans get random seats and the first team colours; bots fill the rest.
    const seats = shuffle([...Array(n).keys()]);
    const humanAt = new Map<number, number>();
    opts.humans.slice(0, n).forEach((_, i) => humanAt.set(seats[i], i));
    let botColor = opts.humans.length;
    for (let b = 0; b < n; b++) {
      const hi = humanAt.get(b);
      const human = hi !== undefined;
      const id = this.players.length;
      const spot = this.map.bases[b];
      const p: Player = {
        id,
        name: human ? opts.humans[hi] : names[b % names.length],
        color: TEAM_COLORS[(human ? hi : botColor++) % TEAM_COLORS.length],
        isBot: !human,
        base: b,
        alive: true,
        gold: START_GOLD,
        coreId: 0,
        kills: 0,
        diedWave: 0,
        builder: {
          x: 0, y: 0, hp: BUILDER_HP, maxHp: BUILDER_HP, dead: false, respawn: 0,
          moveTo: null, targetBp: 0, facing: 1, working: false, moving: false,
        },
        abilityCd: 0,
        ghostCd: 0,
        brain: null,
        ready: !human,
        warned: 0,
        thankedAt: -999,
      };
      if (human) this.humanPids[hi] = id;
      this.players.push(p);
      this.baseOwner[b] = id;
      const core = this.addBuilding('core', id, spot.tx - 1, spot.ty - 1, 3);
      core.started = core.complete = true;
      core.progress = 1;
      core.hp = core.maxHp;
      p.coreId = core.id;
      this.respawnBuilder(p);
      if (!human) p.brain = new BotBrain(id, this.rng);
      this.fields.push(new Float32Array(size * size));
      this.fieldDirty.push(true);
      this.fieldAge.push(0);
    }
    for (const b of this.buildings.values()) this.refreshTile(b);
    for (let i = 0; i < n; i++) this.recomputeField(i);

    this.system(`Match found: ${n} players. The portal opens in ${Math.round(this.phaseTime)} seconds. Build!`);
    for (const p of this.players) {
      if (p.isBot && this.rng.chance(0.35)) {
        this.botSay(p.id, this.rng.pick(['gl hf', 'lets gooo', 'where do i even build', 'good luck all', 'o7', 'hi']), this.rng.range(1, 8));
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  /** The viewer's player, if they have a seat. */
  get human(): Player | null {
    return this.viewerId >= 0 ? this.players[this.viewerId] : null;
  }

  get humanId(): number {
    return this.viewerId;
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  coreOf(base: number): Building | undefined {
    return this.buildings.get(this.players[this.baseOwner[base]].coreId);
  }

  coreCenter(base: number): { x: number; y: number } {
    const s = this.map.bases[base];
    return { x: s.tx + 0.5, y: s.ty + 0.5 };
  }

  aliveCount(): number {
    return this.players.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
  }

  isAliveBase(base: number): boolean {
    return this.players[this.baseOwner[base]].alive;
  }

  /** Nearest living base walking around the ring in direction dir (+1 or -1). */
  neighbourAlive(base: number, dir: number): number {
    const n = this.map.bases.length;
    for (let s = 1; s < n; s++) {
      const b = (((base + dir * s) % n) + n) % n;
      if (this.isAliveBase(b)) return b;
    }
    return -1;
  }

  nextBossWave(): number {
    for (let w = this.wave + 1; w <= TOTAL_WAVES; w++) if (BOSS_WAVES[w]) return w;
    return 0;
  }

  direction(base: number): string {
    const a = this.map.bases[base].angle;
    const names = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
    const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return names[i];
  }

  buildingAt(tx: number, ty: number): Building | undefined {
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return undefined;
    const id = this.bAt[this.idx(tx, ty)];
    return id ? this.buildings.get(id) : undefined;
  }

  stat(b: Building): { damage: number; range: number } {
    const def = BUILDINGS[b.type];
    return { damage: def.damage * LEVEL_DMG[b.level - 1], range: def.range + LEVEL_RANGE[b.level - 1] };
  }

  // ---------------------------------------------------------------- chat

  system(text: string): void {
    this.chat.push({ name: '', color: '#ffd86b', text, system: true });
  }

  say(pid: number, text: string): void {
    const p = this.players[pid];
    this.chat.push({ name: p.name, color: p.color, text, system: false });
    if (p.isBot) return;
    // Bots sometimes answer the human.
    const bots = this.players.filter((b) => b.isBot);
    if (bots.length && this.rng.chance(0.4)) {
      const b = this.rng.pick(bots);
      const lower = text.toLowerCase();
      let reply = this.rng.pick(['lol', 'agreed', 'focus up ppl', 'true', 'ok', 'haha', 'yep', 'we got this']);
      if (lower.includes('help')) reply = this.rng.pick(['omw', 'cant, im getting wrecked too', 'sending a tower', 'hold on!']);
      if (lower.includes('gl') || lower.includes('good luck')) reply = this.rng.pick(['gl!', 'u too', 'hf']);
      this.botSay(b.id, reply, this.rng.range(1.2, 3.5));
    }
  }

  botSay(pid: number, text: string, delay = 0): void {
    this.pendingChat.push({ t: this.time + delay, pid, text });
  }

  ping(pid: number, x: number, y: number): void {
    this.pings.push({ x, y, t: 4, color: this.players[pid].color });
  }

  // ---------------------------------------------------------------- commands

  canPlace(pid: number, tx: number, ty: number): boolean {
    const p = this.players[pid];
    if (!p || !p.alive) return false;
    if (tx < 1 || ty < 1 || tx >= this.size - 1 || ty >= this.size - 1) return false;
    const i = this.idx(tx, ty);
    if (!isBuildableKind(this.map.tiles[i])) return false;
    if (this.bAt[i]) return false;
    const c = this.map.center;
    if (hypot(tx + 0.5 - c, ty + 0.5 - c) < PORTAL_CLEAR) return false;
    return true;
  }

  placeBlueprint(pid: number, type: TowerType, tx: number, ty: number): boolean {
    const p = this.players[pid];
    const def = BUILDINGS[type];
    if (!this.canPlace(pid, tx, ty) || p.gold < def.cost) return false;
    p.gold -= def.cost;
    const b = this.addBuilding(type, pid, tx, ty, 1);
    b.hp = 1;
    return true;
  }

  sell(pid: number, id: number): void {
    const b = this.buildings.get(id);
    if (!b || b.owner !== pid || b.type === 'core' || b.crumble > 0) return;
    const p = this.players[pid];
    p.gold += b.started ? Math.floor(b.invested * SELL_REFUND) : b.invested;
    this.removeBuilding(b);
  }

  upgrade(pid: number, id: number): boolean {
    const b = this.buildings.get(id);
    const p = this.players[pid];
    if (!b || b.owner !== pid || !b.complete || b.type === 'core' || b.level >= MAX_LEVEL || !p.alive) return false;
    const cost = upgradeCost(b.type, b.level);
    if (p.gold < cost) return false;
    p.gold -= cost;
    b.invested += cost;
    b.level++;
    const old = b.maxHp;
    b.maxHp = BUILDINGS[b.type].hp * LEVEL_HP[b.level - 1];
    b.hp += b.maxHp - old;
    b.flash = 0.15;
    this.refreshTile(b);
    this.events.push({ k: 'upgrade', x: b.tx + 0.5, y: b.ty + 0.5 });
    return true;
  }

  moveBuilder(pid: number, x: number, y: number): void {
    const bu = this.players[pid].builder;
    if (bu.dead) return;
    bu.moveTo = { x, y };
  }

  ready(pid: number): void {
    const p = this.players[pid];
    p.ready = true;
    if (this.phase === 'build' && this.players.every((q) => q.ready)) {
      this.phaseTime = Math.min(this.phaseTime, 3);
    }
  }

  /** Applies one player command. Input may come off the network, so check everything. */
  apply(pid: number, c: Command): void {
    const p = this.players[pid];
    if (!p || !c || typeof c !== 'object') return;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    switch (c.k) {
      case 'place':
        if (TOWER_TYPES.includes(c.type) && num(c.x) && num(c.y)) this.placeBlueprint(pid, c.type, Math.floor(c.x), Math.floor(c.y));
        break;
      case 'sell':
        if (num(c.id)) this.sell(pid, c.id);
        break;
      case 'upgrade':
        if (num(c.id)) this.upgrade(pid, c.id);
        break;
      case 'move':
        if (num(c.x) && num(c.y) && p.alive) {
          this.moveBuilder(pid, Math.max(0, Math.min(this.size, c.x)), Math.max(0, Math.min(this.size, c.y)));
        }
        break;
      case 'ability':
        this.ability(pid);
        break;
      case 'ghost':
        if (num(c.id)) this.ghostHeal(pid, c.id);
        break;
      case 'ping':
        if (num(c.x) && num(c.y)) this.ping(pid, c.x, c.y);
        break;
      case 'chat':
        if (typeof c.text === 'string' && c.text.trim()) this.say(pid, c.text.trim().slice(0, 120));
        break;
      case 'ready':
        this.ready(pid);
        break;
      case 'bot':
        if (c.on && !p.isBot) {
          p.isBot = true;
          p.ready = true;
          p.brain = new BotBrain(pid, this.rng);
          this.system(`${p.name} disconnected. A bot is holding their base.`);
          this.ready(pid);
        } else if (!c.on && p.isBot && p.brain) {
          p.isBot = false;
          p.brain = null;
          this.system(`${p.name} is back.`);
        }
        break;
    }
  }

  /**
   * Cheap fingerprint of the simulation. Server and clients compare these to spot
   * a copy that has drifted (different browsers can round floats differently).
   */
  checksum(): number {
    let h = 2166136261 >>> 0;
    const mix = (v: number) => {
      h ^= v | 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(this.tick);
    mix(this.rng.state);
    mix(this.wave);
    mix(this.enemies.length);
    mix(this.buildings.size);
    for (const e of this.enemies) {
      mix(Math.round(e.x * 64));
      mix(Math.round(e.y * 64));
      mix(Math.round(e.hp));
    }
    for (const b of this.buildings.values()) {
      mix(b.id);
      mix(Math.round(b.hp));
    }
    for (const p of this.players) mix(p.gold);
    return h >>> 0;
  }

  /** Dev cheat: bring the next wave forward. */
  debugNextWave(): void {
    if (this.phase === 'build') this.phaseTime = 0.01;
    else if (this.phase === 'waves') this.nextWaveIn = 0.01;
  }

  ability(pid: number): boolean {
    const p = this.players[pid];
    const bu = p.builder;
    if (!p.alive || bu.dead || p.abilityCd > 0) return false;
    p.abilityCd = ABILITY_CD;
    this.rebuildHash();
    const r = 2.8;
    const dmg = 50 + 12 * Math.max(1, this.wave);
    this.forEnemiesInRange(bu.x, bu.y, r, true, true, (e) => {
      this.damageEnemy(e, e.def.boss ? dmg * 0.4 : dmg, pid, '#bff');
      e.slowT = 2;
      e.slowAmt = Math.max(e.slowAmt, 0.6);
    });
    this.events.push({ k: 'shock', x: bu.x, y: bu.y, r });
    this.events.push({ k: 'shake', amt: 4 });
    return true;
  }

  /** Eliminated players can still patch up anyone's buildings. */
  ghostHeal(pid: number, id: number): boolean {
    const p = this.players[pid];
    const b = this.buildings.get(id);
    if (p.alive || p.ghostCd > 0 || !b || !b.complete || b.crumble > 0) return false;
    if (!this.players[b.owner].alive) return false;
    b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.35);
    p.ghostCd = GHOST_CD;
    this.events.push({ k: 'heal', x: b.tx + b.w / 2, y: b.ty + b.w / 2 });
    return true;
  }

  // ---------------------------------------------------------------- buildings

  private addBuilding(type: BuildingType, owner: number, tx: number, ty: number, w: number): Building {
    const def = BUILDINGS[type];
    const b: Building = {
      id: this.nextId++, type, owner, tx, ty, w,
      hp: def.hp, maxHp: def.hp, level: 1,
      started: false, complete: false, progress: 0, cd: 0,
      invested: def.cost, crumble: 0, aimX: 0, aimY: 1, flash: 0,
    };
    this.buildings.set(b.id, b);
    for (let y = ty; y < ty + w; y++) for (let x = tx; x < tx + w; x++) this.bAt[this.idx(x, y)] = b.id;
    return b;
  }

  /** Re-derive pathing cost for the tiles under a building and flag the flow fields. */
  private refreshTile(b: Building): void {
    const def = BUILDINGS[b.type];
    for (let y = b.ty; y < b.ty + b.w; y++) {
      for (let x = b.tx; x < b.tx + b.w; x++) {
        const i = this.idx(x, y);
        const here = this.bAt[i] === b.id;
        if (!here || !b.started) {
          this.grid.cost[i] = 1;
          this.grid.open[i] = this.grid.walk[i];
        } else if (!def.blocks) {
          this.grid.cost[i] = 1.3;
          this.grid.open[i] = 1;
        } else {
          this.grid.cost[i] = b.type === 'core' ? CORE_COST : 18 + b.maxHp / 20;
          this.grid.open[i] = 0;
        }
      }
    }
    this.fieldDirty.fill(true);
  }

  private removeBuilding(b: Building): void {
    this.buildings.delete(b.id);
    for (let y = b.ty; y < b.ty + b.w; y++) {
      for (let x = b.tx; x < b.tx + b.w; x++) {
        const i = this.idx(x, y);
        if (this.bAt[i] === b.id) this.bAt[i] = 0;
      }
    }
    this.refreshTile(b);
  }

  private destroyBuilding(b: Building): void {
    if (!this.buildings.has(b.id)) return;
    this.events.push({ k: 'bdie', x: b.tx + b.w / 2, y: b.ty + b.w / 2, w: b.w, type: b.type });
    this.removeBuilding(b);
    if (b.type === 'core') this.eliminate(b.owner);
  }

  damageBuilding(b: Building, dmg: number): void {
    if (b.crumble > 0) return;
    b.hp -= dmg;
    b.flash = 0.12;
    if (b.type === 'core') this.coreHurt(b);
    if (b.hp <= 0) this.destroyBuilding(b);
  }

  private coreHurt(b: Building): void {
    const p = this.players[b.owner];
    const frac = b.hp / b.maxHp;
    const level = frac < 0.3 ? 2 : frac < 0.6 ? 1 : 0;
    if (level > p.warned) {
      p.warned = level;
      const c = this.coreCenter(p.base);
      this.ping(p.id, c.x, c.y);
      if (p.isBot) {
        const dir = this.direction(p.base);
        this.botSay(p.id, level === 2
          ? this.rng.pick([`HELP ${dir} side going down`, 'im dying here!!', 'core almost gone', 'SOS'])
          : this.rng.pick([`help ${dir}?`, 'getting pushed', 'they broke my walls', 'need help']));
      } else if (p.id === this.viewerId) {
        this.events.push({ k: 'banner', text: 'Your core is under attack', sub: `${Math.ceil(frac * 100)}% left`, style: 'bad' });
      }
    }
  }

  private eliminate(pid: number): void {
    const p = this.players[pid];
    if (!p.alive) return;
    p.alive = false;
    p.diedWave = this.wave;
    p.builder.dead = true;
    for (const b of this.buildings.values()) {
      if (b.owner === pid) b.crumble = this.rng.range(0.2, 2.5);
    }
    const left = this.neighbourAlive(p.base, -1);
    const right = this.neighbourAlive(p.base, 1);
    let flip = 0;
    for (const e of this.enemies) {
      if (e.target !== p.base) continue;
      const nb = flip++ % 2 ? left : right;
      e.target = nb >= 0 ? nb : left;
    }
    this.events.push({ k: 'shake', amt: 8 });
    const nbNames = [left, right].filter((x, i, a) => x >= 0 && a.indexOf(x) === i)
      .map((x) => this.players[this.baseOwner[x]].name);
    this.system(`${p.name}'s core has fallen!${nbNames.length ? ` Their share of the horde now heads for ${nbNames.join(' and ')}.` : ''}`);
    if (p.isBot) {
      this.botSay(pid, this.rng.pick(['gg im out', 'nooo', 'rip', 'well that was fast', 'avenge me', 'ill haunt your towers']), 1);
    } else if (pid === this.viewerId) {
      this.events.push({ k: 'banner', text: 'Your core has fallen', sub: 'Your ghost can still repair allies: click their buildings', style: 'bad' });
    }
    for (const nb of [left, right]) {
      if (nb < 0) continue;
      const q = this.players[this.baseOwner[nb]];
      if (q.isBot && this.rng.chance(0.5)) {
        this.botSay(q.id, this.rng.pick(['uh oh thats coming my way', 'brace yourselves', 'they are all coming here now', 'great.']), this.rng.range(2, 4));
      }
    }
    if (this.aliveCount() === 0) this.endMatch(false);
  }

  // ---------------------------------------------------------------- enemies

  private spawnEnemy(type: EnemyType, base: number, x?: number, y?: number): Enemy {
    const def = ENEMIES[type];
    if (x === undefined || y === undefined) {
      const c = this.map.center;
      const a = this.map.bases[base].angle + this.rng.range(-0.35, 0.35);
      x = c + cos(a) * 2.2;
      y = c + sin(a) * 2.2;
    }
    const hp = def.boss ? def.hp : def.hp * hpMul(this.wave);
    const e: Enemy = {
      id: this.nextId++, type, def, x, y, hp, maxHp: hp, target: base,
      ox: this.rng.range(-0.28, 0.28), oy: this.rng.range(-0.28, 0.28),
      atkCd: 0, slowT: 0, slowAmt: 0, facing: 1, abilityCd: this.rng.range(1, 3),
      dead: false, hitFlash: -1, anim: this.rng.range(0, 10), attacking: false,
      dmg: def.boss ? def.damage : def.damage * dmgMul(this.wave),
    };
    this.enemies.push(e);
    if (def.boss) this.events.push({ k: 'spawn', x, y, boss: true });
    return e;
  }

  damageEnemy(e: Enemy, dmg: number, owner: number, color = '#fff'): void {
    if (e.dead) return;
    e.hp -= dmg;
    // Flash white on a hit, but not constantly: a boss under fire would just be a white blob.
    if (e.hitFlash <= -0.25) e.hitFlash = 0.07;
    if (e.hp <= 0) this.killEnemy(e, owner);
    else if (this.rng.chance(0.3)) this.events.push({ k: 'hit', x: e.x, y: e.y, color });
  }

  private killEnemy(e: Enemy, owner: number): void {
    e.dead = true;
    this.events.push({ k: 'die', x: e.x, y: e.y, type: e.type, boss: e.def.boss });
    const p = this.players[owner];
    if (p && p.alive) {
      const bounty = Math.round(e.def.bounty * (e.def.boss ? 1 : 1 + this.wave * 0.05));
      p.gold += bounty;
      p.kills++;
      if (owner === this.humanId) this.events.push({ k: 'gold', x: e.x, y: e.y, amount: bounty });
    }
    if (e.type === 'brood') {
      for (let i = 0; i < 6; i++) this.spawnEnemy('spider', e.target, e.x + this.rng.range(-0.6, 0.6), e.y + this.rng.range(-0.6, 0.6));
    }
    if (e.def.boss) {
      this.events.push({ k: 'shake', amt: 6 });
      const killer = p ? p.name : 'Someone';
      this.system(`${killer} took down the ${e.def.name}!`);
    }
  }

  // ---------------------------------------------------------------- waves

  private startWave(w: number): void {
    this.wave = w;
    this.phase = 'waves';
    this.nextWaveIn = w >= TOTAL_WAVES ? Infinity : WAVE_INTERVAL;
    for (const p of this.players) if (p.alive) p.gold += waveIncome(w);
    const spec = waveSpec(w);
    const n = this.map.bases.length;
    for (let b = 0; b < n; b++) {
      const alive = this.isAliveBase(b);
      for (const [type, count] of spec.groups) {
        const c = alive ? count : Math.round(count * FALLEN_SHARE);
        for (let k = 0; k < c; k++) {
          const target = alive ? b : this.neighbourAlive(b, k % 2 ? 1 : -1);
          if (target < 0) continue;
          this.spawnQueue.push({ t: this.time + (k / Math.max(1, c)) * 9 + this.rng.range(0, 0.6), type, base: target });
        }
      }
      if (spec.boss && alive) this.spawnQueue.push({ t: this.time + 3.5, type: spec.boss, base: b });
    }
    this.spawnQueue.sort((a, b) => a.t - b.t);
    if (spec.boss) {
      this.events.push({ k: 'banner', text: `Miniboss: ${spec.name}`, sub: BOSS_BLURB[spec.boss] ?? '', style: 'boss' });
      this.events.push({ k: 'shake', amt: 5 });
      this.system(`Wave ${w}: ${/^[AEIOU]/.test(spec.name) ? 'an' : 'a'} ${spec.name} is coming for every base. ${BOSS_BLURB[spec.boss] ?? ''}`);
      const talkers = this.players.filter((p) => p.isBot && p.alive);
      if (talkers.length) this.botSay(this.rng.pick(talkers).id, this.rng.pick(['BOSS INCOMING', 'oh no its big', 'focus the boss!', 'here we go']), this.rng.range(1, 3));
    } else {
      this.events.push({ k: 'banner', text: `Wave ${w}`, sub: spec.name, style: 'wave' });
    }
  }

  private endMatch(victory: boolean): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    const survivors = this.aliveCount();
    this.result = { victory, wave: this.wave, survivors, total: this.players.length };
    if (victory) {
      this.system(`The portal collapses! ${survivors} of ${this.players.length} bases survived.`);
      this.events.push({ k: 'banner', text: 'Victory', sub: `${survivors} of ${this.players.length} bases survived`, style: 'good' });
    } else {
      this.system('Every core has fallen. The horde wins this one.');
    }
  }

  /** One player's share of the result. Everyone gets the survivor bonus, fallen or not. */
  playerResult(pid: number): PlayerResult {
    const p = this.players[pid];
    const r = this.result;
    const survived = p.alive;
    const reached = survived ? this.wave : p.diedWave;
    const survivors = r ? r.survivors : this.aliveCount();
    const shards = 5 * reached + 12 * survivors + (survived ? 40 : 0) + (r?.victory ? 60 : 0);
    return { survived, diedWave: p.diedWave, kills: p.kills, shards };
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    this.tick++;
    this.time += dt;
    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i].t -= dt;
      if (this.pings[i].t <= 0) this.pings.splice(i, 1);
    }
    for (let i = this.pendingChat.length - 1; i >= 0; i--) {
      const m = this.pendingChat[i];
      if (m.t <= this.time) {
        this.pendingChat.splice(i, 1);
        this.say(m.pid, m.text);
      }
    }
    if (this.phase === 'over') {
      this.updateEnemies(dt);
      this.updateProjectiles(dt);
      return;
    }

    if (this.phase === 'build') {
      this.phaseTime -= dt;
      if (this.phaseTime <= 0) {
        this.system('The portal is open. Here they come!');
        this.startWave(1);
      }
    } else {
      this.nextWaveIn -= dt;
      if (this.nextWaveIn <= 0 && this.wave < TOTAL_WAVES) this.startWave(this.wave + 1);
    }
    while (this.spawnQueue.length && this.spawnQueue[0].t <= this.time) {
      const s = this.spawnQueue.shift()!;
      const base = this.isAliveBase(s.base) ? s.base : this.neighbourAlive(s.base, this.rng.chance(0.5) ? 1 : -1);
      if (base >= 0) this.spawnEnemy(s.type, base);
    }

    this.refreshFields();

    for (const p of this.players) {
      p.abilityCd = Math.max(0, p.abilityCd - dt);
      p.ghostCd = Math.max(0, p.ghostCd - dt);
      if (p.brain) p.brain.update(this, dt);
      this.updateBuilder(p, dt);
    }

    this.updateEnemies(dt);
    this.rebuildHash();
    this.updateBuildings(dt);
    this.updateProjectiles(dt);

    if (this.wave >= TOTAL_WAVES && this.spawnQueue.length === 0 && this.enemies.length === 0) {
      this.endMatch(true);
    }
  }

  /**
   * Flow fields are the expensive part of a tick, so: none while nobody is walking
   * (the build phase), only for bases something is actually heading to, the
   * stalest one first, and one per tick. Enemies follow a slightly old field
   * for a few ticks, which is fine.
   */
  private refreshFields(): void {
    if (this.phase !== 'waves') return;
    const wanted = new Uint8Array(this.fieldDirty.length);
    for (const e of this.enemies) if (!e.def.flying) wanted[e.target] = 1;
    for (const s of this.spawnQueue) wanted[s.base] = 1;
    let pick = -1;
    for (let i = 0; i < wanted.length; i++) {
      if (!wanted[i] || !this.fieldDirty[i] || !this.isAliveBase(i)) continue;
      if (pick < 0 || this.fieldAge[i] < this.fieldAge[pick]) pick = i;
    }
    if (pick >= 0) this.recomputeField(pick);
  }

  private recomputeField(base: number): void {
    this.fieldAge[base] = this.time;
    const s = this.map.bases[base];
    const goals: number[] = [];
    for (let y = s.ty - 1; y <= s.ty + 1; y++) for (let x = s.tx - 1; x <= s.tx + 1; x++) goals.push(this.idx(x, y));
    computeField(this.grid, goals, this.fields[base]);
    this.fieldDirty[base] = false;
  }

  private respawnBuilder(p: Player): void {
    const s = this.map.bases[p.base];
    const c = this.map.center;
    const a = atan2(c - (s.ty + 0.5), c - (s.tx + 0.5));
    const bu = p.builder;
    bu.x = s.tx + 0.5 + cos(a) * 2.4;
    bu.y = s.ty + 0.5 + sin(a) * 2.4;
    bu.hp = bu.maxHp;
    bu.dead = false;
    bu.moveTo = null;
  }

  private moveToward(bu: Builder, x: number, y: number, dt: number, stopAt = 0): boolean {
    const dx = x - bu.x, dy = y - bu.y;
    const d = hypot(dx, dy);
    if (d <= stopAt + 0.02) return true;
    const step = BUILDER_SPEED * dt;
    if (Math.abs(dx) > 0.05) bu.facing = dx > 0 ? 1 : -1;
    bu.moving = true;
    if (d - stopAt <= step) {
      bu.x += (dx / d) * (d - stopAt);
      bu.y += (dy / d) * (d - stopAt);
      return true;
    }
    bu.x += (dx / d) * step;
    bu.y += (dy / d) * step;
    return false;
  }

  private updateBuilder(p: Player, dt: number): void {
    const bu = p.builder;
    bu.working = false;
    bu.moving = false;
    if (!p.alive) return;
    if (bu.dead) {
      bu.respawn -= dt;
      if (bu.respawn <= 0) this.respawnBuilder(p);
      return;
    }
    if (bu.moveTo) {
      if (this.moveToward(bu, bu.moveTo.x, bu.moveTo.y, dt)) bu.moveTo = null;
      return;
    }
    let bp = bu.targetBp ? this.buildings.get(bu.targetBp) : undefined;
    if (!bp || bp.complete || bp.owner !== p.id) {
      bp = undefined;
      let best = Infinity;
      for (const b of this.buildings.values()) {
        if (b.owner !== p.id || b.complete) continue;
        const d = hypot(b.tx + 0.5 - bu.x, b.ty + 0.5 - bu.y);
        if (d < best) { best = d; bp = b; }
      }
      bu.targetBp = bp ? bp.id : 0;
    }
    if (bp) {
      const cx = bp.tx + 0.5, cy = bp.ty + 0.5;
      if (!this.moveToward(bu, cx, cy, dt, 1.0)) return;
      bu.working = true;
      if (Math.abs(cx - bu.x) > 0.05) bu.facing = cx > bu.x ? 1 : -1;
      if (!bp.started) {
        bp.started = true;
        this.refreshTile(bp);
      }
      const def = BUILDINGS[bp.type];
      bp.progress += dt / def.buildTime;
      bp.hp = Math.min(bp.maxHp, bp.hp + (bp.maxHp * dt) / def.buildTime);
      if (bp.progress >= 1) {
        bp.complete = true;
        bp.progress = 1;
        this.events.push({ k: 'built', x: cx, y: cy, owner: p.id });
        this.checkHelp(p, bp);
      }
      return;
    }
    // Nothing to build: patch up the most damaged building nearby.
    let rep: Building | undefined;
    let worst = 1;
    for (const b of this.buildings.values()) {
      if (b.owner !== p.id || !b.complete || b.crumble > 0 || b.hp >= b.maxHp) continue;
      const cx = b.tx + b.w / 2, cy = b.ty + b.w / 2;
      if (hypot(cx - bu.x, cy - bu.y) > 7) continue;
      const f = b.hp / b.maxHp;
      if (f < worst) { worst = f; rep = b; }
    }
    if (rep) {
      const cx = rep.tx + rep.w / 2, cy = rep.ty + rep.w / 2;
      if (this.moveToward(bu, cx, cy, dt, rep.w === 3 ? 2 : 1)) {
        bu.working = true;
        rep.hp = Math.min(rep.maxHp, rep.hp + (rep.type === 'core' ? 18 : 30) * dt);
      }
    }
  }

  /** Bots notice when you build something near their base. */
  private checkHelp(builder: Player, b: Building): void {
    for (const q of this.players) {
      if (q.id === builder.id || !q.alive || !q.isBot) continue;
      const c = this.coreCenter(q.base);
      if (hypot(c.x - b.tx, c.y - b.ty) > 10) continue;
      if (this.time - q.thankedAt < 60) continue;
      q.thankedAt = this.time;
      this.botSay(q.id, this.rng.pick([`ty ${builder.name}!`, `${builder.name} the hero`, 'thanks for the help', 'appreciate it!!']), 1.2);
    }
  }

  private updateEnemies(dt: number): void {
    const g = this.grid;
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.anim += dt;
      e.hitFlash = Math.max(-1, e.hitFlash - dt);
      e.atkCd -= dt;
      let speed = e.def.speed;
      if (e.slowT > 0) {
        e.slowT -= dt;
        speed *= 1 - e.slowAmt;
      } else e.slowAmt = 0;
      e.attacking = false;
      if (this.phase === 'over') continue;
      if (!this.isAliveBase(e.target)) {
        const nb = this.neighbourAlive(e.target, e.id % 2 ? 1 : -1);
        if (nb < 0) continue;
        e.target = nb;
      }
      if (e.def.boss) this.bossAbility(e, dt);

      // Builders that wander too close get mobbed.
      if (this.attackBuilders(e)) continue;

      const core = this.coreOf(e.target);
      if (!core) continue;
      const cc = this.coreCenter(e.target);
      if (e.def.flying) {
        const dx = cc.x - e.x, dy = cc.y - e.y;
        const d = hypot(dx, dy);
        if (d < 1.7 + e.def.radius) {
          this.enemyAttack(e, core);
        } else {
          e.x += (dx / d) * speed * dt;
          e.y += (dy / d) * speed * dt;
          if (Math.abs(dx) > 0.05) e.facing = dx > 0 ? 1 : -1;
        }
        continue;
      }
      const tx = Math.floor(e.x), ty = Math.floor(e.y);
      const field = this.fields[e.target];
      const here = tx >= 0 && ty >= 0 && tx < this.size && ty < this.size ? this.idx(tx, ty) : -1;
      if (here >= 0 && field[here] === 0) {
        this.enemyAttack(e, core);
        continue;
      }
      const u = here >= 0 ? nextStep(g, field, tx, ty) : -1;
      let gx: number, gy: number;
      if (u < 0) {
        gx = cc.x;
        gy = cc.y;
      } else {
        const bid = this.bAt[u];
        if (bid) {
          const b = this.buildings.get(bid);
          if (b && b.started && BUILDINGS[b.type].blocks) {
            if (b.id === core.id || field[u] === 0) this.enemyAttack(e, core);
            else this.enemyAttack(e, b);
            continue;
          }
        }
        gx = (u % this.size) + 0.5 + e.ox;
        gy = ((u / this.size) | 0) + 0.5 + e.oy;
      }
      const dx = gx - e.x, dy = gy - e.y;
      const d = hypot(dx, dy);
      if (d > 0.001) {
        const step = Math.min(d, speed * dt);
        e.x += (dx / d) * step;
        e.y += (dy / d) * step;
        if (Math.abs(dx) > 0.03) e.facing = dx > 0 ? 1 : -1;
      }
    }
    if (this.enemies.some((e) => e.dead)) this.enemies = this.enemies.filter((e) => !e.dead);
  }

  private attackBuilders(e: Enemy): boolean {
    for (const p of this.players) {
      const bu = p.builder;
      if (!p.alive || bu.dead) continue;
      if (Math.abs(bu.x - e.x) > 0.9 || Math.abs(bu.y - e.y) > 0.9) continue;
      if (hypot(bu.x - e.x, bu.y - e.y) > 0.75 + e.def.radius * 0.5) continue;
      e.attacking = true;
      if (e.atkCd <= 0) {
        e.atkCd = e.def.rate;
        bu.hp -= e.dmg;
        this.events.push({ k: 'hit', x: bu.x, y: bu.y, color: '#f66' });
        if (bu.hp <= 0) {
          bu.dead = true;
          bu.respawn = 8;
          bu.targetBp = 0;
          this.events.push({ k: 'die', x: bu.x, y: bu.y, type: 'spider', boss: false });
          if (p.id === this.humanId) this.events.push({ k: 'banner', text: 'Your builder was knocked out', sub: 'Back at your core in 8 seconds', style: 'bad' });
        }
      }
      return true;
    }
    return false;
  }

  private enemyAttack(e: Enemy, b: Building): void {
    e.attacking = true;
    const bx = b.tx + b.w / 2;
    if (Math.abs(bx - e.x) > 0.05) e.facing = bx > e.x ? 1 : -1;
    if (e.atkCd > 0) return;
    e.atkCd = e.def.rate;
    this.damageBuilding(b, e.dmg * (b.type === 'core' ? 1 : e.def.bdmg));
    if (e.type === 'ogre' || e.type === 'titan') this.events.push({ k: 'shake', amt: 2 });
  }

  private bossAbility(e: Enemy, dt: number): void {
    e.abilityCd -= dt;
    if (e.abilityCd > 0) return;
    switch (e.type) {
      case 'brood':
        e.abilityCd = 4;
        for (let i = 0; i < 2; i++) this.spawnEnemy('spider', e.target, e.x + this.rng.range(-0.5, 0.5), e.y + this.rng.range(-0.5, 0.5));
        break;
      case 'titan':
        e.abilityCd = 6;
        for (let i = 0; i < 3; i++) this.spawnEnemy('grunt', e.target, e.x + this.rng.range(-0.8, 0.8), e.y + this.rng.range(-0.8, 0.8));
        break;
      case 'warlock': {
        e.abilityCd = 3;
        let healed = false;
        for (const o of this.enemies) {
          if (o.dead || o === e || hypot(o.x - e.x, o.y - e.y) > 3) continue;
          o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.1);
          healed = true;
        }
        if (healed) this.events.push({ k: 'frost', x: e.x, y: e.y, r: -3 });
        break;
      }
      case 'golem': {
        let target: Building | undefined;
        let best = 4;
        for (const b of this.buildings.values()) {
          if (!b.started || !BUILDINGS[b.type].blocks || b.type === 'wall' || b.crumble > 0) continue;
          const d = hypot(b.tx + b.w / 2 - e.x, b.ty + b.w / 2 - e.y);
          if (d < best) { best = d; target = b; }
        }
        if (target) {
          e.abilityCd = 3.5;
          this.projectiles.push({
            kind: 'boulder', x: e.x, y: e.y, sx: e.x, sy: e.y,
            tx: target.tx + target.w / 2, ty: target.ty + target.w / 2, t: 0, dur: 0.3 + best / 7,
            speed: 0, damage: 160, splash: 0, owner: -1, target: null, building: target, done: false,
          });
        } else e.abilityCd = 0.5;
        break;
      }
      default:
        e.abilityCd = 99;
    }
  }

  // ---------------------------------------------------------------- towers

  private rebuildHash(): void {
    this.heads.fill(-1);
    if (this.links.length < this.enemies.length) this.links = new Int32Array(this.enemies.length * 2);
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const cx = Math.min(this.cw - 1, Math.max(0, Math.floor(e.x / this.cell)));
      const cy = Math.min(this.cw - 1, Math.max(0, Math.floor(e.y / this.cell)));
      const c = cy * this.cw + cx;
      this.links[i] = this.heads[c];
      this.heads[c] = i;
    }
  }

  forEnemiesInRange(x: number, y: number, r: number, air: boolean, ground: boolean, cb: (e: Enemy, d: number) => void): void {
    const x0 = Math.max(0, Math.floor((x - r - 1) / this.cell)), x1 = Math.min(this.cw - 1, Math.floor((x + r + 1) / this.cell));
    const y0 = Math.max(0, Math.floor((y - r - 1) / this.cell)), y1 = Math.min(this.cw - 1, Math.floor((y + r + 1) / this.cell));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let i = this.heads[cy * this.cw + cx]; i >= 0; i = this.links[i]) {
          const e = this.enemies[i];
          if (!e || e.dead) continue;
          if (e.def.flying ? !air : !ground) continue;
          const d = hypot(e.x - x, e.y - y);
          if (d <= r + e.def.radius * 0.5) cb(e, d);
        }
      }
    }
  }

  private nearest(x: number, y: number, r: number, air: boolean, ground: boolean, skip?: Set<Enemy>): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    this.forEnemiesInRange(x, y, r, air, ground, (e, d) => {
      if (skip && skip.has(e)) return;
      // Prefer bosses slightly so they don't walk past distracted towers.
      const score = e.def.boss ? d - 1.5 : d;
      if (score < bd) { bd = score; best = e; }
    });
    return best;
  }

  private updateBuildings(dt: number): void {
    for (const b of this.buildings.values()) {
      b.flash = Math.max(0, b.flash - dt);
      if (b.crumble > 0) {
        b.crumble -= dt;
        if (b.crumble <= 0) this.destroyBuilding(b);
        continue;
      }
      if (!b.complete || b.type === 'wall') continue;
      b.cd -= dt;
      if (b.cd > 0) continue;
      const def = BUILDINGS[b.type];
      const { damage, range } = this.stat(b);
      const cx = b.tx + b.w / 2, cy = b.ty + b.w / 2;
      b.cd = 0.1;
      switch (b.type) {
        case 'arrow':
        case 'core': {
          const t = this.nearest(cx, cy, range, def.air, true);
          if (!t) break;
          b.cd = def.rate;
          b.aimX = t.x - cx;
          b.aimY = t.y - cy;
          this.projectiles.push({
            kind: b.type === 'core' ? 'spark' : 'arrow', x: cx, y: cy - (b.w === 3 ? 1.6 : 0.8), sx: cx, sy: cy, tx: t.x, ty: t.y,
            t: 0, dur: 0, speed: 15, damage, splash: 0, owner: b.owner, target: t, building: null, done: false,
          });
          break;
        }
        case 'cannon': {
          const t = this.nearest(cx, cy, range, false, true);
          if (!t) break;
          b.cd = def.rate;
          b.aimX = t.x - cx;
          b.aimY = t.y - cy;
          const d = hypot(t.x - cx, t.y - cy);
          this.projectiles.push({
            kind: 'ball', x: cx, y: cy, sx: cx, sy: cy - 0.5, tx: t.x, ty: t.y, t: 0, dur: 0.25 + d / 9,
            speed: 0, damage, splash: def.splash, owner: b.owner, target: null, building: null, done: false,
          });
          break;
        }
        case 'frost': {
          let any = false;
          this.forEnemiesInRange(cx, cy, range, true, true, (e) => {
            any = true;
            e.slowT = 1.5;
            e.slowAmt = Math.max(e.slowAmt, def.slow * (e.def.boss ? 0.6 : 1));
            this.damageEnemy(e, damage, b.owner, '#bdf');
          });
          if (any) {
            b.cd = def.rate;
            this.events.push({ k: 'frost', x: cx, y: cy, r: range });
          }
          break;
        }
        case 'tesla': {
          let t = this.nearest(cx, cy, range, true, true);
          if (!t) break;
          b.cd = def.rate;
          const hit = new Set<Enemy>();
          const pts = [cx, cy - 1.1];
          let dmg = damage;
          for (let k = 0; k < def.chain && t; k++) {
            hit.add(t);
            pts.push(t.x, t.y - 0.3);
            this.damageEnemy(t, dmg, b.owner, '#d8b8ff');
            dmg *= 0.7;
            t = this.nearest(t.x, t.y, 2.5, true, true, hit);
          }
          this.events.push({ k: 'bolt', pts });
          break;
        }
        case 'spikes': {
          let hits = 0;
          this.forEnemiesInRange(cx, cy, 0.55, false, true, (e) => {
            hits++;
            this.damageEnemy(e, damage, b.owner, '#f88');
          });
          if (hits) {
            b.cd = def.rate;
            this.damageBuilding(b, hits * 1.5);
          }
          break;
        }
      }
    }
  }

  private updateProjectiles(dt: number): void {
    for (const pr of this.projectiles) {
      if (pr.kind === 'arrow' || pr.kind === 'spark') {
        if (pr.target && !pr.target.dead) {
          pr.tx = pr.target.x;
          pr.ty = pr.target.y - 0.3;
        }
        const dx = pr.tx - pr.x, dy = pr.ty - pr.y;
        const d = hypot(dx, dy);
        const step = pr.speed * dt;
        if (d <= step) {
          pr.done = true;
          if (pr.target && !pr.target.dead) this.damageEnemy(pr.target, pr.damage, pr.owner);
        } else {
          pr.x += (dx / d) * step;
          pr.y += (dy / d) * step;
        }
      } else {
        pr.t += dt;
        const f = Math.min(1, pr.t / pr.dur);
        pr.x = pr.sx + (pr.tx - pr.sx) * f;
        pr.y = pr.sy + (pr.ty - pr.sy) * f;
        if (f >= 1) {
          pr.done = true;
          if (pr.kind === 'ball') {
            this.events.push({ k: 'boom', x: pr.tx, y: pr.ty, r: pr.splash });
            this.forEnemiesInRange(pr.tx, pr.ty, pr.splash, false, true, (e, d) => {
              this.damageEnemy(e, pr.damage * (1 - 0.5 * Math.min(1, d / pr.splash)), pr.owner, '#fc8');
            });
          } else if (pr.building && this.buildings.has(pr.building.id)) {
            this.events.push({ k: 'boom', x: pr.tx, y: pr.ty, r: 0.8 });
            this.damageBuilding(pr.building, pr.damage);
          }
        }
      }
    }
    if (this.projectiles.some((p) => p.done)) this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  // ---------------------------------------------------------------- save / restore

  /** The full match state, for spectators and players joining mid-match. */
  toSnapshot(): Snapshot {
    return {
      opts: this.opts,
      tick: this.tick, time: this.time, phase: this.phase, phaseTime: this.phaseTime,
      wave: this.wave, nextWaveIn: this.nextWaveIn, nextId: this.nextId, rng: this.rng.state,
      spawnQueue: this.spawnQueue, pendingChat: this.pendingChat, chat: this.chat.slice(-60),
      pings: this.pings, result: this.result,
      players: this.players.map(({ brain, ...p }) => ({ ...p, builder: { ...p.builder }, brain: brain ? brain.save() : null })),
      buildings: [...this.buildings.values()],
      enemies: this.enemies.map(({ def: _def, ...e }) => e),
      projectiles: this.projectiles.map((pr) => ({ ...pr, target: pr.target ? pr.target.id : 0, building: pr.building ? pr.building.id : 0 })),
      fieldDirty: this.fieldDirty, fieldAge: this.fieldAge,
      fields: this.fields.map(encodeF32),
    };
  }

  static fromSnapshot(s: Snapshot): Game {
    const g = new Game(s.opts);
    Object.assign(g, {
      tick: s.tick, time: s.time, phase: s.phase, phaseTime: s.phaseTime, wave: s.wave,
      nextWaveIn: s.nextWaveIn ?? Infinity, nextId: s.nextId, spawnQueue: s.spawnQueue,
      pendingChat: s.pendingChat, chat: s.chat, pings: s.pings, result: s.result,
    });
    g.rng.state = s.rng;
    g.players = s.players.map((sp) => {
      const { brain, ...rest } = sp;
      const p: Player = { ...rest, builder: { ...sp.builder }, brain: null };
      if (brain) {
        p.brain = new BotBrain(p.id, g.rng);
        p.brain.load(brain);
      }
      return p;
    });
    g.rng.state = s.rng;
    g.buildings.clear();
    g.bAt.fill(0);
    for (let i = 0; i < g.grid.cost.length; i++) {
      g.grid.cost[i] = 1;
      g.grid.open[i] = g.grid.walk[i];
    }
    for (const b of s.buildings) {
      const nb: Building = { ...b };
      g.buildings.set(nb.id, nb);
      for (let y = nb.ty; y < nb.ty + nb.w; y++) for (let x = nb.tx; x < nb.tx + nb.w; x++) g.bAt[g.idx(x, y)] = nb.id;
    }
    for (const b of g.buildings.values()) g.refreshTile(b);
    g.enemies = s.enemies.map((e) => ({ ...e, def: ENEMIES[e.type] }));
    const byId = new Map(g.enemies.map((e) => [e.id, e]));
    g.projectiles = s.projectiles.map((pr) => ({
      ...pr, target: byId.get(pr.target) ?? null, building: g.buildings.get(pr.building) ?? null,
    }));
    g.fieldDirty = [...s.fieldDirty];
    g.fieldAge = [...s.fieldAge];
    g.fields = s.fields.map(decodeF32);
    return g;
  }
}

type SavedPlayer = Omit<Player, 'brain'> & { brain: ReturnType<BotBrain['save']> | null };

export interface Snapshot {
  opts: GameOptions;
  tick: number;
  time: number;
  phase: Game['phase'];
  phaseTime: number;
  wave: number;
  nextWaveIn: number | null;
  nextId: number;
  rng: number;
  spawnQueue: Game['spawnQueue'];
  pendingChat: Game['pendingChat'];
  chat: ChatMsg[];
  pings: Ping[];
  result: MatchResult | null;
  players: SavedPlayer[];
  buildings: Building[];
  enemies: Omit<Enemy, 'def'>[];
  projectiles: (Omit<Projectile, 'target' | 'building'> & { target: number; building: number })[];
  fieldDirty: boolean[];
  fieldAge: number[];
  fields: string[];
}

function encodeF32(f: Float32Array): string {
  const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function decodeF32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
