// Headless balance check: plays all-bot matches at full speed and reports when bases fall.
// Run with: node tools/balance.ts [matches] [players]

import { Game } from '../src/game.ts';
import { TICK } from '../src/config.ts';

const argv: string[] = (globalThis as unknown as { process?: { argv: string[] } }).process?.argv ?? [];
const matches = Number(argv[2] ?? 6);
const players = Number(argv[3] ?? 8);

const deaths: number[] = [];
let wins = 0;
let survivorsTotal = 0;
for (let m = 0; m < matches; m++) {
  const t0 = performance.now();
  const g = new Game({ players, humans: [], seed: 1000 + m * 7919 });
  let steps = 0;
  let maxEnemies = 0;
  while (g.phase !== 'over' && steps < 30 * 60 * 40) {
    g.update(TICK);
    g.events.length = 0;
    steps++;
    if (g.enemies.length > maxEnemies) maxEnemies = g.enemies.length;
  }
  const died = g.players.filter((p) => !p.alive).map((p) => p.diedWave).sort((a, b) => a - b);
  deaths.push(...died);
  const alive = g.aliveCount();
  survivorsTotal += alive;
  if (g.result?.victory) wins++;
  const skills = g.players.map((p) => `${p.alive ? 'Y' : p.diedWave}@${p.brain?.skill.toFixed(2)}`).join(' ');
  console.log(
    `match ${m}: ${g.result?.victory ? 'WIN ' : 'LOSS'} wave ${g.wave} survivors ${alive}/${players}` +
    ` peak enemies ${maxEnemies} sim ${((steps * TICK) / 60).toFixed(1)}min in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(`   ${skills}`);
}
const hist: Record<number, number> = {};
for (const d of deaths) hist[d] = (hist[d] ?? 0) + 1;
console.log(`\nwins ${wins}/${matches}, avg survivors ${(survivorsTotal / matches).toFixed(1)}/${players}`);
console.log('deaths by wave:', JSON.stringify(hist));
