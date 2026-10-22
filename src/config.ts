// All the tunable numbers for a match live here.

export const TICK = 1 / 30;
export const BUILD_PHASE = 120;
export const WAVE_INTERVAL = 30;
export const TOTAL_WAVES = 30;
export const START_GOLD = 220;
export const SELL_REFUND = 0.7;
/** Share of a fallen base's wave that still spawns and goes to its neighbours. */
export const FALLEN_SHARE = 0.6;

export type TowerType = 'wall' | 'arrow' | 'cannon' | 'frost' | 'tesla' | 'spikes';
export type BuildingType = TowerType | 'core';

export interface BuildingDef {
  type: BuildingType;
  name: string;
  cost: number;
  hp: number;
  buildTime: number;
  /** Enemies must break through (or path around) blocking buildings. */
  blocks: boolean;
  hotkey: string;
  desc: string;
  range: number;
  damage: number;
  rate: number;
  air: boolean;
  ground: boolean;
  splash: number;
  slow: number;
  chain: number;
}

const base = {
  range: 0, damage: 0, rate: 1, air: false, ground: true,
  splash: 0, slow: 0, chain: 0, blocks: true, cost: 0, buildTime: 1, hotkey: '',
};

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  wall: {
    ...base, type: 'wall', name: 'Wall', cost: 8, hp: 320, buildTime: 0.5, hotkey: '1',
    desc: 'Blocks the horde. They walk around or smash through.',
  },
  arrow: {
    ...base, type: 'arrow', name: 'Archer tower', cost: 30, hp: 220, buildTime: 1.4, hotkey: '2',
    desc: 'Fast single-target shots. Hits air.', range: 5.5, damage: 9, rate: 0.6, air: true,
  },
  cannon: {
    ...base, type: 'cannon', name: 'Cannon', cost: 60, hp: 300, buildTime: 1.8, hotkey: '3',
    desc: 'Slow, heavy splash damage. Ground only.', range: 5, damage: 26, rate: 1.7, splash: 1.3,
  },
  frost: {
    ...base, type: 'frost', name: 'Frost spire', cost: 50, hp: 220, buildTime: 1.6, hotkey: '4',
    desc: 'Pulses cold that slows everything nearby. Hits air.', range: 3.5, damage: 3, rate: 1.0, air: true, slow: 0.45,
  },
  tesla: {
    ...base, type: 'tesla', name: 'Tesla coil', cost: 100, hp: 240, buildTime: 2.2, hotkey: '5',
    desc: 'Lightning that chains between enemies. Hits air.', range: 4.5, damage: 22, rate: 1.25, air: true, chain: 3,
  },
  spikes: {
    ...base, type: 'spikes', name: 'Spike trap', cost: 15, hp: 120, buildTime: 0.8, hotkey: '6',
    desc: 'Enemies walk over it and bleed. Wears out.', damage: 7, rate: 0.5, blocks: false,
  },
  core: {
    ...base, type: 'core', name: 'Core', hp: 1600, buildTime: 0,
    desc: 'Your base. If it falls, you are out.', range: 4.5, damage: 7, rate: 0.7, air: true,
  },
};

export const TOWER_TYPES: TowerType[] = ['wall', 'arrow', 'cannon', 'frost', 'tesla', 'spikes'];
export const MAX_LEVEL = 3;
export const LEVEL_DMG = [1, 1.75, 2.9];
export const LEVEL_HP = [1, 1.6, 2.5];
export const LEVEL_RANGE = [0, 0.5, 1];

export function upgradeCost(type: BuildingType, level: number): number {
  return Math.round(BUILDINGS[type].cost * (level === 1 ? 1.1 : 1.8));
}

export type EnemyType =
  | 'grunt' | 'runner' | 'brute' | 'bat' | 'spider'
  | 'ogre' | 'brood' | 'wraith' | 'golem' | 'warlock' | 'titan';

export interface EnemyDef {
  type: EnemyType;
  name: string;
  hp: number;
  speed: number;
  damage: number;
  rate: number;
  bounty: number;
  flying: boolean;
  boss: boolean;
  /** Damage multiplier against buildings. */
  bdmg: number;
  radius: number;
}

const e = { flying: false, boss: false, bdmg: 1 };

export const ENEMIES: Record<EnemyType, EnemyDef> = {
  grunt: { ...e, type: 'grunt', name: 'Goblin', hp: 32, speed: 1.5, damage: 8, rate: 1.0, bounty: 2, radius: 0.3 },
  runner: { ...e, type: 'runner', name: 'Imp', hp: 20, speed: 2.6, damage: 5, rate: 0.7, bounty: 2, radius: 0.28 },
  brute: { ...e, type: 'brute', name: 'Brute', hp: 150, speed: 1.0, damage: 22, rate: 1.2, bounty: 6, bdmg: 1.5, radius: 0.42 },
  bat: { ...e, type: 'bat', name: 'Bat', hp: 26, speed: 2.1, damage: 6, rate: 1.0, bounty: 3, flying: true, radius: 0.3 },
  spider: { ...e, type: 'spider', name: 'Spiderling', hp: 14, speed: 2.3, damage: 4, rate: 0.8, bounty: 1, radius: 0.25 },
  ogre: { ...e, type: 'ogre', name: 'Ogre Chieftain', hp: 2600, speed: 0.9, damage: 45, rate: 1.4, bounty: 70, boss: true, bdmg: 3, radius: 0.7 },
  brood: { ...e, type: 'brood', name: 'Broodmother', hp: 4500, speed: 1.0, damage: 30, rate: 1.2, bounty: 90, boss: true, bdmg: 1.5, radius: 0.8 },
  wraith: { ...e, type: 'wraith', name: 'Wraith', hp: 5500, speed: 1.7, damage: 40, rate: 1.0, bounty: 100, flying: true, boss: true, radius: 0.6 },
  golem: { ...e, type: 'golem', name: 'Siege Golem', hp: 15000, speed: 0.7, damage: 70, rate: 2.0, bounty: 130, boss: true, bdmg: 2, radius: 0.75 },
  warlock: { ...e, type: 'warlock', name: 'Warlock', hp: 13000, speed: 1.1, damage: 25, rate: 1.0, bounty: 140, boss: true, radius: 0.6 },
  titan: { ...e, type: 'titan', name: 'Portal Titan', hp: 42000, speed: 0.6, damage: 150, rate: 1.5, bounty: 400, boss: true, bdmg: 3, radius: 1.1 },
};

/** A miniboss for every base, every 5 waves. */
export const BOSS_WAVES: Record<number, EnemyType> = {
  5: 'ogre', 10: 'brood', 15: 'wraith', 20: 'golem', 25: 'warlock', 30: 'titan',
};

export const BOSS_BLURB: Record<string, string> = {
  ogre: 'Smashes walls three times as hard.',
  brood: 'Spawns spiderlings, and more when she dies.',
  wraith: 'Flies over your walls. Only anti-air can touch it.',
  golem: 'Throws boulders at towers from range.',
  warlock: 'Heals the horde around him.',
  titan: 'The portal itself walks. Hold the line.',
};

export function hpMul(w: number): number {
  const x = Math.max(0, w - 1);
  return 1 + 0.16 * x + 0.012 * x * x;
}

export function dmgMul(w: number): number {
  return 1 + 0.05 * Math.max(0, w - 1);
}

export function waveIncome(w: number): number {
  return 25 + 4 * w;
}

export interface WaveSpec {
  name: string;
  groups: [EnemyType, number][];
  boss?: EnemyType;
}

const SWARM = [7, 13, 18, 23, 28];
const AIR = [9, 14, 19, 24, 29];
const BRUTES = [12, 17, 22, 27];

/** Enemies per base for wave w. */
export function waveSpec(w: number): WaveSpec {
  const n = 4 + Math.floor(w * 0.85);
  const boss = BOSS_WAVES[w];
  if (boss) {
    const groups: [EnemyType, number][] = [['grunt', Math.ceil(n * 0.6)]];
    if (w >= 10) groups.push(['brute', Math.floor(n * 0.15)]);
    if (w >= 20) groups.push(['runner', Math.floor(n * 0.3)]);
    return { name: ENEMIES[boss].name, boss, groups };
  }
  if (SWARM.includes(w)) return { name: 'Swarm', groups: [['runner', Math.ceil(n * 1.4)], ['grunt', Math.floor(n * 0.3)]] };
  if (AIR.includes(w)) return { name: 'Air raid', groups: [['bat', Math.ceil(n * 0.7)], ['grunt', Math.floor(n * 0.4)]] };
  if (BRUTES.includes(w)) return { name: 'Brutes', groups: [['brute', Math.ceil(n * 0.45)], ['grunt', Math.floor(n * 0.5)]] };
  const groups: [EnemyType, number][] = [];
  let grunts = n;
  if (w >= 3) { const r = Math.floor(n * 0.25); groups.push(['runner', r]); grunts -= r; }
  if (w >= 6) { const b = Math.floor(n * 0.12); groups.push(['brute', b]); grunts -= b; }
  if (w >= 10) { const b = Math.floor(n * 0.1); groups.push(['bat', b]); grunts -= b; }
  groups.unshift(['grunt', grunts]);
  return { name: 'Horde', groups };
}

export const TEAM_COLORS = [
  '#4aa3ff', '#ff5d5d', '#ffd23f', '#5ee08a', '#c77dff', '#ff9f43', '#3fe0d0', '#ff6fb5',
  '#a3e635', '#f0f0f0', '#8b9dff', '#e0a96d', '#00c2ff', '#ff4f8b', '#9be15d', '#d0a6ff',
];

export const BOT_NAMES = [
  'Grimble', 'xX_Turret_Xx', 'moss_queen', 'Kael', 'pixelpaladin', 'OrcHugger', 'Thrall2005',
  'sunflower', 'turretlord', 'Nyx', 'bricklayer', 'Vex', 'wombat', 'Mira', 'deadeye_dan',
  'gnomebro', 'Haze', 'castlecat', 'Juno', 'lagwizard',
];
