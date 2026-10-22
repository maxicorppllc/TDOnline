// Checks the two things online play depends on:
// 1. two copies of a match fed the same commands stay identical (lockstep), and
// 2. a match saved mid-game and restored (how spectators join) carries on identically.
// Run with: node tools/netcheck.ts

import { Game } from '../src/game.ts';
import type { Command } from '../src/game.ts';
import { TICK, TOWER_TYPES } from '../src/config.ts';

const opts = { players: 8, humans: ['alice', 'bob'], seed: 4242 };
const a = new Game(opts);
const b = new Game(opts);
let rnd = 7;
const r = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function randomCommand(g: Game): Command {
  const c = g.map.bases[g.players[g.humanPids[0]].base];
  const roll = r();
  if (roll < 0.6) return { k: 'place', type: TOWER_TYPES[Math.floor(r() * 6)], x: c.tx + Math.floor(r() * 13) - 6, y: c.ty + Math.floor(r() * 13) - 6 };
  if (roll < 0.7) return { k: 'chat', text: 'help gl' };
  if (roll < 0.8) return { k: 'ability' };
  if (roll < 0.9) return { k: 'move', x: c.tx + r() * 6, y: c.ty + r() * 6 };
  const ids = [...g.buildings.keys()];
  return { k: 'upgrade', id: ids[Math.floor(r() * ids.length)] };
}

let restored: Game | null = null;
let fails = 0;
for (let t = 0; t < 30 * 60 * 8; t++) {
  if (t === 30 * 60 * 3) {
    restored = Game.fromSnapshot(JSON.parse(JSON.stringify(a.toSnapshot())));
    if (restored.checksum() !== a.checksum()) { console.log('snapshot restore mismatch at', t); fails++; }
  }
  const cmds: [number, Command][] = [];
  if (r() < 0.05) cmds.push([a.humanPids[Math.floor(r() * 2)], randomCommand(a)]);
  if (t === 30 * 60 * 4) cmds.push([a.humanPids[1], { k: 'bot', on: true }]);
  for (const g of [a, b, restored]) {
    if (!g) continue;
    for (const [pid, c] of cmds) g.apply(pid, c);
    g.update(TICK);
    g.events.length = 0;
  }
  if (t % 600 === 0 || t === 30 * 60 * 8 - 1) {
    const sums = [a.checksum(), b.checksum(), restored?.checksum()];
    const ok = sums[0] === sums[1] && (sums[2] === undefined || sums[2] === sums[0]);
    if (!ok) fails++;
    console.log(`tick ${a.tick} wave ${a.wave} enemies ${a.enemies.length} ${ok ? 'in sync' : 'DESYNC ' + sums.join(' ')}`);
  }
}
console.log(fails ? `FAILED (${fails})` : 'all copies stayed identical');
