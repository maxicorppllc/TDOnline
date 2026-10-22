// Bot players. They issue the same commands a human does, so in a real
// multiplayer match they'd fill empty seats without any special casing.

import { BUILDINGS, MAX_LEVEL, upgradeCost } from './config.ts';
import type { TowerType } from './config.ts';
import type { Rng } from './rng.ts';
import { atan2, cos, sin } from './dmath.ts';
import type { Building, Game } from './game.ts';

interface Goal {
  type: TowerType;
  count: number;
  minWave?: number;
}

const OPENING: Goal[] = [
  { type: 'arrow', count: 3 },
  { type: 'frost', count: 1 },
  { type: 'arrow', count: 4 },
  { type: 'cannon', count: 1 },
  { type: 'spikes', count: 3 },
  { type: 'cannon', count: 2, minWave: 2 },
  { type: 'arrow', count: 6, minWave: 4 },
  { type: 'wall', count: 40, minWave: 5 },
  { type: 'tesla', count: 1, minWave: 6 },
  { type: 'frost', count: 2, minWave: 7 },
  { type: 'tesla', count: 2, minWave: 9 },
];

export class BotBrain {
  pid: number;
  skill: number;
  private think: number;
  private rng: Rng;
  private wallSlots: [number, number][] | null = null;

  constructor(pid: number, rng: Rng) {
    this.pid = pid;
    this.rng = rng;
    this.skill = rng.range(0.4, 1);
    this.think = rng.range(0.5, 2.5);
  }

  save(): { skill: number; think: number; wallSlots: [number, number][] | null } {
    return { skill: this.skill, think: this.think, wallSlots: this.wallSlots };
  }

  load(s: { skill: number; think: number; wallSlots: [number, number][] | null }): void {
    this.skill = s.skill;
    this.think = s.think;
    this.wallSlots = s.wallSlots;
  }

  update(g: Game, dt: number): void {
    const p = g.players[this.pid];
    this.think -= dt;
    if (this.think > 0) return;
    this.think = this.rng.range(0.8, 2.0) / this.skill;
    if (!p.alive) {
      this.ghost(g);
      return;
    }
    let pending = 0;
    for (const b of g.buildings.values()) if (b.owner === this.pid && !b.complete) pending++;
    if (pending >= 3) return;

    const mine = [...g.buildings.values()].filter((b) => b.owner === this.pid && b.type !== 'core');
    const count = (t: TowerType) => mine.filter((b) => b.type === t).length;

    for (const goal of OPENING) {
      if ((goal.minWave ?? 0) > g.wave) continue;
      if (goal.type === 'wall' && this.skill < 0.6) continue;
      if (count(goal.type) >= goal.count) continue;
      if (p.gold < BUILDINGS[goal.type].cost) return; // save up for it
      if (goal.type === 'wall') this.placeWalls(g, 4);
      else this.place(g, goal.type);
      return;
    }

    // Past the opening: keep anti-air up, then mix upgrades and new towers.
    const airTowers = mine.filter((b) => b.type === 'arrow' || b.type === 'tesla' || b.type === 'frost').length;
    if (airTowers < 4 + g.wave / 4 && p.gold >= 30) {
      this.place(g, p.gold >= 100 && this.rng.chance(0.4) ? 'tesla' : 'arrow');
      return;
    }
    const upgradeable = mine.filter((b) => b.complete && b.level < MAX_LEVEL && b.type !== 'spikes');
    const wantUpgrade = this.rng.chance(Math.min(0.75, 0.25 + g.wave / 40));
    if (wantUpgrade && upgradeable.length) {
      const pick = this.pickUpgrade(upgradeable);
      if (pick && p.gold >= upgradeCost(pick.type, pick.level)) g.upgrade(this.pid, pick.id);
      return;
    }
    const choice = this.rng.pick<TowerType>(['arrow', 'arrow', 'cannon', 'cannon', 'tesla', 'frost', 'spikes', 'wall']);
    if (p.gold < BUILDINGS[choice].cost) return;
    if (choice === 'wall') this.placeWalls(g, 3);
    else this.place(g, choice);
  }

  private pickUpgrade(list: Building[]): Building | undefined {
    // Damage towers first, walls later.
    const towers = list.filter((b) => b.type !== 'wall');
    return this.rng.pick(towers.length && this.rng.chance(0.8) ? towers : list);
  }

  private frontAngle(g: Game): number {
    const s = g.map.bases[g.players[this.pid].base];
    return atan2(g.map.center - (s.ty + 0.5), g.map.center - (s.tx + 0.5));
  }

  private place(g: Game, type: TowerType): void {
    const s = g.map.bases[g.players[this.pid].base];
    const front = this.frontAngle(g);
    // Good bots cover every side (the horde flanks around walls); weak bots only guard the front.
    const spread = this.skill > 0.6 ? Math.PI : 1.2;
    const [r0, r1] = type === 'spikes' ? [7.5, 9.5] : [2.6, 4.8 + g.wave / 15];
    for (let tries = 0; tries < 30; tries++) {
      const frontBias = this.rng.chance(0.55) ? 0.45 : 1;
      const a = front + this.rng.range(-spread, spread) * frontBias;
      const r = this.rng.range(r0, r1);
      const tx = Math.round(s.tx + cos(a) * r);
      const ty = Math.round(s.ty + sin(a) * r);
      if (g.canPlace(this.pid, tx, ty) && g.placeBlueprint(this.pid, type, tx, ty)) return;
    }
  }

  /** A full wall ring around the base, about seven tiles out, built front first. */
  private placeWalls(g: Game, n: number): void {
    const s = g.map.bases[g.players[this.pid].base];
    if (!this.wallSlots) {
      const front = this.frontAngle(g);
      const r = 6.5;
      const slots: [number, number, number][] = [];
      const seen = new Set<string>();
      for (let a = -Math.PI; a < Math.PI; a += 0.05) {
        const tx = Math.round(s.tx + cos(front + a) * r);
        const ty = Math.round(s.ty + sin(front + a) * r);
        const k = `${tx},${ty}`;
        if (!seen.has(k)) { seen.add(k); slots.push([tx, ty, Math.abs(a)]); }
      }
      slots.sort((p, q) => p[2] - q[2]);
      this.wallSlots = slots.map(([x, y]) => [x, y]);
    }
    let placed = 0;
    for (const [tx, ty] of this.wallSlots) {
      if (placed >= n) break;
      if (g.canPlace(this.pid, tx, ty) && g.placeBlueprint(this.pid, 'wall', tx, ty)) placed++;
    }
    if (!placed) this.place(g, 'wall');
  }

  private ghost(g: Game): void {
    const p = g.players[this.pid];
    if (p.ghostCd > 0) return;
    let worst: Building | undefined;
    let wf = 0.6;
    for (const b of g.buildings.values()) {
      if (!b.complete || b.crumble > 0 || !g.players[b.owner].alive) continue;
      const f = b.hp / b.maxHp;
      if (f < wf) { wf = f; worst = b; }
    }
    if (worst) g.ghostHeal(this.pid, worst.id);
  }
}
