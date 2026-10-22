// Entry point: lobby -> queue -> match -> results.
// Matches run online through the game server, or locally in Practice mode.

import { BUILDINGS, TICK, TOWER_TYPES } from './config.ts';
import type { TowerType } from './config.ts';
import { Game } from './game.ts';
import type { Command } from './game.ts';
import { MAP_SIZES } from './protocol.ts';
import type { LiveMatch, ServerMsg } from './protocol.ts';
import { Net } from './net.ts';
import { Renderer } from './render.ts';
import { Hud } from './ui.ts';

/** `?dev` in the URL enables Practice cheat keys: `]` next wave now, `[` +500 gold. */
const DEV = new URLSearchParams(location.search).has('dev');
const app = document.getElementById('app') as HTMLElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: fine, nothing important lives there
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Identifies this tab to the server so a refresh puts you back in your seat. */
const TOKEN = (() => {
  const fresh = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  try {
    let t = sessionStorage.getItem('tdo.token');
    if (!t) {
      t = fresh();
      sessionStorage.setItem('tdo.token', t);
    }
    return t;
  } catch {
    return fresh();
  }
})();

let playerName = load('tdo.name', `Builder${Math.floor(Math.random() * 900 + 100)}`);
let mapSize = Number(load('tdo.size', '8'));
let lobby: { online: number; queues: Record<number, number>; matches: LiveMatch[] } | null = null;
let current: Match | null = null;
let screen: HTMLElement | null = null;

const net = new Net(() => ({ k: 'hello', name: playerName, token: TOKEN }));

function setScreen(el: HTMLElement | null): void {
  screen?.remove();
  screen = el;
  if (el) app.appendChild(el);
}

function endCurrent(): void {
  if (!current) return;
  current.destroy();
  current = null;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ------------------------------------------------------------------ server messages

net.onStatus = (on) => {
  if (screen?.dataset.view === 'lobby') updateLobby();
  if (screen?.dataset.view === 'queue' && !on) showLobby('Lost connection to the game server.');
  current?.netStatus(on);
};

net.onMessage = (m: ServerMsg) => {
  switch (m.k) {
    case 'welcome':
      break;
    case 'lobby':
      lobby = m;
      if (screen?.dataset.view === 'lobby') updateLobby();
      break;
    case 'queue':
      if (screen?.dataset.view === 'queue') updateQueue(m);
      break;
    case 'start': {
      setScreen(null);
      endCurrent();
      const g = new Game(m.opts);
      current = new Match(g, { viewer: m.pid, online: true, matchId: m.match, size: m.opts.players });
      break;
    }
    case 'snapshot': {
      const g = Game.fromSnapshot(m.snap);
      if (current && current.online && current.matchId === m.match) {
        current.replaceGame(g);
      } else {
        // Spectating, or back from a refresh into a match we were playing.
        setScreen(null);
        endCurrent();
        current = new Match(g, { viewer: m.pid, online: true, matchId: m.match, size: m.snap.opts.players });
      }
      break;
    }
    case 'ticks':
      current?.onTicks(m.upTo, m.cmds);
      break;
    case 'sum':
      current?.onSum(m.tick, m.sum);
      break;
    case 'ended':
      if (current && current.online && !current.resultShown) showLobby(m.reason);
      break;
    case 'error':
      if (screen?.dataset.view === 'lobby') showLobby(m.text);
      break;
  }
};

// ------------------------------------------------------------------ lobby

function showLobby(notice = ''): void {
  endCurrent();
  const shards = Number(load('tdo.shards', '0'));
  const el = document.createElement('div');
  el.className = 'screen';
  el.dataset.view = 'lobby';
  el.innerHTML = `
    <div class="card panel">
      <div class="logo">TD ONLINE</div>
      <div class="tag">Drop in. Build fast. Hold the line together.</div>
      <div class="status" id="status"><span class="dot"></span><span id="statustext"></span></div>
      <div class="notice ${notice ? '' : 'hidden'}">${esc(notice)}</div>
      <div class="field"><label>Your name</label><input id="name" maxlength="16" value="${esc(playerName)}" /></div>
      <div class="field"><label>Map size</label>
        <div class="sizes">
          ${MAP_SIZES.map((n) => `<button data-n="${n}" class="${n === mapSize ? 'on' : ''}">${n}<small>${n === 4 ? 'small' : n === 8 ? 'standard' : 'huge'}</small><small class="q" data-q="${n}"></small></button>`).join('')}
        </div>
      </div>
      <div class="actions">
        <button id="play" class="primary">Find match</button>
        <button id="practice">Practice offline (you + bots)</button>
      </div>
      <div class="live"><h3>Live matches</h3><div id="live"></div></div>
      <div class="how">
        <b>How it works.</b> Everyone spawns around a portal. You get two minutes to build
        before the horde pours out and rushes every base at once. A miniboss comes every 5 waves.
        When a base falls, its share of the horde moves on to the neighbours, so help each other:
        the more bases that survive all 30 waves, the bigger everyone's reward.
      </div>
      <div class="shards">Shards: ${shards}</div>
    </div>`;
  setScreen(el);
  const input = el.querySelector('#name') as HTMLInputElement;
  const commitName = () => {
    playerName = input.value.trim().slice(0, 16) || 'Builder';
    save('tdo.name', playerName);
    net.send({ k: 'hello', name: playerName, token: TOKEN });
  };
  input.addEventListener('change', commitName);
  for (const b of el.querySelectorAll<HTMLButtonElement>('.sizes button')) {
    b.onclick = () => {
      mapSize = Number(b.dataset.n);
      save('tdo.size', String(mapSize));
      for (const o of el.querySelectorAll('.sizes button')) o.classList.toggle('on', o === b);
    };
  }
  (el.querySelector('#play') as HTMLButtonElement).onclick = () => {
    commitName();
    showQueue();
    net.send({ k: 'queue', size: mapSize });
  };
  (el.querySelector('#practice') as HTMLButtonElement).onclick = () => {
    commitName();
    startPractice(mapSize);
  };
  updateLobby();
}

function updateLobby(): void {
  const el = screen;
  if (!el || el.dataset.view !== 'lobby') return;
  const status = el.querySelector('#status') as HTMLElement;
  status.classList.toggle('on', net.connected);
  (el.querySelector('#statustext') as HTMLElement).textContent = net.connected
    ? `Connected · ${lobby?.online ?? 1} online`
    : 'Game server offline. Practice still works; start the server with npm run dev.';
  (el.querySelector('#play') as HTMLButtonElement).disabled = !net.connected;
  for (const q of el.querySelectorAll<HTMLElement>('[data-q]')) {
    const n = lobby?.queues[Number(q.dataset.q)] ?? 0;
    q.textContent = net.connected && n ? `${n} in queue` : '';
  }
  const live = el.querySelector('#live') as HTMLElement;
  const ms = net.connected ? lobby?.matches ?? [] : [];
  const key = JSON.stringify([net.connected, ms]);
  if (live.dataset.key === key) return;
  live.dataset.key = key;
  if (!ms.length) {
    live.innerHTML = `<div class="empty">${net.connected ? 'No matches running right now.' : 'Connect to see live matches.'}</div>`;
    return;
  }
  live.innerHTML = '';
  for (const m of ms) {
    const row = document.createElement('div');
    row.className = 'row';
    const where = m.phase === 'build' ? 'building' : m.phase === 'over' ? 'finished' : `wave ${m.wave}`;
    row.innerHTML = `<div class="meta">${m.size} players · ${where} · ${m.alive} alive
      <small>${m.humans.length ? esc(m.humans.join(', ')) : 'all bots'}${m.spectators ? ` · ${m.spectators} watching` : ''}</small></div>`;
    const b = document.createElement('button');
    b.textContent = 'Watch';
    b.onclick = () => net.send({ k: 'spectate', id: m.id });
    row.appendChild(b);
    live.appendChild(row);
  }
}

// ------------------------------------------------------------------ queue

function showQueue(): void {
  endCurrent();
  const el = document.createElement('div');
  el.className = 'screen';
  el.dataset.view = 'queue';
  el.innerHTML = `
    <div class="card panel">
      <div class="tag" id="qtitle">Finding a ${mapSize}-player match</div>
      <div class="queue-count"><span id="qn">1</span> / ${mapSize}</div>
      <div class="queue-list" id="ql"></div>
      <div class="tag" id="qwait">Joining the queue...</div>
      <div class="row-btns">
        <button id="now" class="gold">Start now with bots</button>
        <button id="cancel">Cancel</button>
      </div>
    </div>`;
  setScreen(el);
  updateQueue({ size: mapSize, names: [playerName], startsIn: 0, votes: 0 });
  (el.querySelector('#now') as HTMLButtonElement).onclick = (e) => {
    net.send({ k: 'startNow' });
    (e.currentTarget as HTMLButtonElement).disabled = true;
  };
  (el.querySelector('#cancel') as HTMLButtonElement).onclick = () => {
    net.send({ k: 'unqueue' });
    showLobby();
  };
}

function updateQueue(m: { size: number; names: string[]; startsIn: number; votes: number }): void {
  const el = screen;
  if (!el || el.dataset.view !== 'queue') return;
  (el.querySelector('#qn') as HTMLElement).textContent = String(m.names.length);
  const list = el.querySelector('#ql') as HTMLElement;
  list.innerHTML = '';
  for (let i = 0; i < m.size; i++) {
    const d = document.createElement('div');
    const n = m.names[i];
    if (n) {
      d.style.setProperty('--c', i === 0 ? '#4aa3ff' : '#ffd23f');
      d.textContent = n + (n === playerName ? ' (you)' : '');
    } else {
      d.className = 'empty';
      d.textContent = 'open seat';
    }
    list.appendChild(d);
  }
  const s = m.startsIn;
  const wait = m.startsIn ? `Bots fill the empty seats in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Waiting for the server...';
  const votes = m.names.length > 1 && m.votes ? ` · ${m.votes} of ${m.names.length} want to start now` : '';
  (el.querySelector('#qwait') as HTMLElement).textContent = wait + votes;
}

// ------------------------------------------------------------------ results

function showResult(m: Match): void {
  const g = m.game;
  const r = g.result;
  if (!r) return;
  const me = g.human;
  const pr = me ? g.playerResult(me.id) : null;
  const total = Number(load('tdo.shards', '0')) + (pr ? pr.shards : 0);
  if (pr) save('tdo.shards', String(total));
  const el = document.createElement('div');
  el.className = 'screen';
  el.dataset.view = 'result';
  el.innerHTML = `
    <div class="card panel">
      <div class="result-title ${r.victory ? 'win' : 'lose'}">${r.victory ? 'Victory' : 'Overrun'}</div>
      <div class="tag">${r.victory ? 'The portal collapsed.' : 'Every core fell.'} ${r.survivors} of ${r.total} bases survived.</div>
      ${pr ? `
      <div class="stats">
        <span>You</span><span>${pr.survived ? 'survived!' : `fell on wave ${pr.diedWave}`}</span>
        <span>Waves reached</span><span>${r.wave}</span>
        <span>Your kills</span><span>${pr.kills}</span>
        <span>Survivor bonus (${r.survivors} alive)</span><span>+${12 * r.survivors}</span>
        <span>Shards earned</span><span>+${pr.shards}</span>
        <span>Total shards</span><span>${total}</span>
      </div>
      <div class="bonus-note">Every base that survives raises everyone's reward, even for players who fell.</div>` : ''}
      <div class="row-btns">
        ${pr ? '<button id="again" class="primary">Play again</button>' : ''}
        <button id="watch">Keep watching</button>
        <button id="lobby">Lobby</button>
      </div>
    </div>`;
  setScreen(el);
  el.querySelector<HTMLButtonElement>('#again')?.addEventListener('click', () => {
    if (m.online) {
      net.send({ k: 'leave' });
      showQueue();
      net.send({ k: 'queue', size: m.size });
    } else {
      startPractice(m.size);
    }
  });
  (el.querySelector('#watch') as HTMLButtonElement).onclick = () => setScreen(null);
  (el.querySelector('#lobby') as HTMLButtonElement).onclick = () => {
    if (m.online) net.send({ k: 'leave' });
    showLobby();
  };
}

// ------------------------------------------------------------------ match

function startPractice(size: number): void {
  setScreen(null);
  endCurrent();
  const g = new Game({ players: size, humans: [playerName], seed: Math.floor(Math.random() * 2 ** 31) });
  current = new Match(g, { viewer: g.humanPids[0], online: false, matchId: 0, size });
}

interface MatchOpts {
  viewer: number;
  online: boolean;
  matchId: number;
  size: number;
}

class Match {
  game: Game;
  renderer: Renderer;
  hud: Hud;
  online: boolean;
  matchId: number;
  size: number;
  viewer: number;
  placing: TowerType | null = null;
  selected = 0;
  resultShown = false;
  private keys = new Set<string>();
  private speed = 1;
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private dragPaint = false;
  private lastPaint = { x: -1, y: -1 };
  private panning: { x: number; y: number; cx: number; cy: number } | null = null;
  private mouse = { x: 0, y: 0 };
  private cleanup: (() => void)[] = [];
  // Practice: commands wait for the next tick, same as online.
  private localCmds: Command[] = [];
  // Online: the server's tick stream.
  private upTo = 0;
  private cmdsByTick = new Map<number, [number, Command][]>();
  private sums = new Map<number, number>();
  private resyncing = false;
  private lostAt = 0;

  constructor(game: Game, o: MatchOpts) {
    this.online = o.online;
    this.matchId = o.matchId;
    this.size = o.size;
    this.viewer = o.viewer;
    game.viewerId = o.viewer;
    this.game = game;
    this.upTo = game.tick;
    this.renderer = new Renderer(canvas, game);
    this.renderer.onBanner = (e) => this.hud.banner(e.text, e.sub, e.style);
    const spectating = o.viewer < 0;
    this.hud = new Hud(app, game, this.renderer, {
      selectTower: (t) => this.togglePlacing(t),
      ability: () => this.send({ k: 'ability' }),
      upgrade: () => this.upgrade(),
      sell: () => this.sell(),
      ready: () => this.send({ k: 'ready' }),
      leave: () => this.leave(),
      speed: () => {
        this.speed = this.speed >= 3 ? 1 : this.speed + 1;
        this.hud.speedLabel = `${this.speed}x`;
      },
      sendChat: (text) => this.send({ k: 'chat', text }),
      jumpTo: (x, y) => {
        this.renderer.cam.x = x;
        this.renderer.cam.y = y;
        this.renderer.clampCam();
      },
    }, spectating, o.online);
    this.hud.netLabel = o.online ? (spectating ? 'Spectating live' : 'Online') : 'Practice';
    if (spectating) this.hud.banner('Spectating', `A live ${o.size}-player match`, 'wave');
    else if (game.phase === 'build' && game.tick < 30) this.hud.banner('Build your defenses', 'The portal opens in 2:00', 'wave');
    else this.hud.banner('Back in the fight', 'Your base held while you were gone', 'wave');
    this.bind();
    this.raf = requestAnimationFrame(this.frame);
    if (DEV) (window as unknown as { td: Match }).td = this;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const f of this.cleanup) f();
    this.hud.destroy();
  }

  // ---------------------------------------------------------------- network

  onTicks(upTo: number, cmds: [number, number, Command][]): void {
    for (const [t, pid, c] of cmds) {
      if (t < this.game.tick) continue;
      let list = this.cmdsByTick.get(t);
      if (!list) this.cmdsByTick.set(t, (list = []));
      list.push([pid, c]);
    }
    this.upTo = Math.max(this.upTo, upTo);
  }

  onSum(tick: number, sum: number): void {
    if (tick < this.game.tick) return;
    if (tick === this.game.tick) this.checkSum(sum);
    else this.sums.set(tick, sum);
  }

  private checkSum(sum: number): void {
    if (this.resyncing || sum === this.game.checksum()) return;
    console.warn(`desync at tick ${this.game.tick}; asking the server for a fresh copy`);
    this.resyncing = true;
    net.send({ k: 'resync' });
  }

  replaceGame(g: Game): void {
    g.viewerId = this.viewer;
    this.game = g;
    this.renderer.game = g;
    this.hud.setGame(g);
    this.upTo = Math.max(this.upTo, g.tick);
    for (const t of [...this.cmdsByTick.keys()]) if (t < g.tick) this.cmdsByTick.delete(t);
    for (const t of [...this.sums.keys()]) if (t <= g.tick) this.sums.delete(t);
    this.resyncing = false;
    this.lostAt = 0;
  }

  netStatus(on: boolean): void {
    if (!this.online) return;
    this.hud.netLabel = on ? 'Online' : 'Reconnecting...';
    // The server sends a snapshot when it seats us again. If none comes, the match is gone.
    if (on) this.lostAt = performance.now();
  }

  private send(c: Command): void {
    if (this.viewer < 0) return;
    if (this.online) net.send({ k: 'cmd', c });
    else this.localCmds.push(c);
  }

  private stepOnline(): void {
    const g = this.game;
    const cmds = this.cmdsByTick.get(g.tick);
    if (cmds) {
      for (const [pid, c] of cmds) g.apply(pid, c);
      this.cmdsByTick.delete(g.tick);
    }
    g.update(TICK);
    const s = this.sums.get(g.tick);
    if (s !== undefined) {
      this.sums.delete(g.tick);
      this.checkSum(s);
    }
  }

  private advance(real: number): void {
    const g = this.game;
    if (!this.online) {
      this.acc += real * this.speed;
      let steps = 0;
      while (this.acc >= TICK && steps < 12) {
        for (const c of this.localCmds) g.apply(this.viewer, c);
        this.localCmds = [];
        g.update(TICK);
        this.acc -= TICK;
        steps++;
      }
      if (steps >= 12) this.acc = 0;
      return;
    }
    // Follow the server's clock: real time normally, faster when we've fallen behind.
    this.acc = Math.min(this.acc + real, 0.25);
    let steps = 0;
    while (g.tick < this.upTo && steps < 90 && (this.acc >= TICK || this.upTo - g.tick > 6)) {
      this.stepOnline();
      this.acc = Math.max(0, this.acc - TICK);
      steps++;
    }
    if (this.lostAt && performance.now() - this.lostAt > 4000) showLobby('The server restarted, so that match is gone.');
  }

  // ---------------------------------------------------------------- actions

  private leave(): void {
    const playing = this.viewer >= 0 && this.game.phase !== 'over';
    if (playing && !confirm(this.online ? 'Leave this match? A bot will take over your base.' : 'Leave this practice match?')) return;
    if (this.online) net.send({ k: 'leave' });
    showLobby();
  }

  private get me() {
    return this.game.human;
  }

  private togglePlacing(t: TowerType): void {
    if (!this.me || !this.me.alive) return;
    this.placing = this.placing === t ? null : t;
    this.selected = 0;
  }

  private upgrade(): void {
    if (this.selected) this.send({ k: 'upgrade', id: this.selected });
  }

  private sell(): void {
    if (!this.selected) return;
    this.send({ k: 'sell', id: this.selected });
    this.selected = 0;
  }

  /** Whether a placement looks valid right now (the sim has the final say). */
  private canPlace(type: TowerType, tx: number, ty: number): boolean {
    const me = this.me;
    return !!me && this.game.canPlace(me.id, tx, ty) && me.gold >= BUILDINGS[type].cost;
  }

  private tileAt(sx: number, sy: number): { x: number; y: number; tx: number; ty: number } {
    const w = this.renderer.screenToWorld(sx, sy);
    return { x: w.x, y: w.y, tx: Math.floor(w.x), ty: Math.floor(w.y) };
  }

  private paintTo(tx: number, ty: number): void {
    if (!this.placing) return;
    // Fill the gap between mouse samples so fast drags don't leave holes in walls.
    const { x: x0, y: y0 } = this.lastPaint;
    const steps = x0 < 0 ? 0 : Math.max(Math.abs(tx - x0), Math.abs(ty - y0));
    const tiles: [number, number][] = [];
    for (let s = 1; s <= steps; s++) tiles.push([Math.round(x0 + ((tx - x0) * s) / steps), Math.round(y0 + ((ty - y0) * s) / steps)]);
    if (steps === 0) tiles.push([tx, ty]);
    for (const [x, y] of tiles) if (this.game.canPlace(this.viewer, x, y)) this.send({ k: 'place', type: this.placing, x, y });
    this.lastPaint = { x: tx, y: ty };
  }

  private bind(): void {
    this.on(canvas, 'contextmenu', (e) => e.preventDefault());
    this.on(canvas, 'mousedown', (e) => {
      const t = this.tileAt(e.clientX, e.clientY);
      const me = this.me;
      if (e.button === 1) {
        e.preventDefault();
        this.panning = { x: e.clientX, y: e.clientY, cx: this.renderer.cam.x, cy: this.renderer.cam.y };
        return;
      }
      if (e.button === 2) {
        if (this.placing) this.placing = null;
        else if (me && me.alive) {
          this.send({ k: 'move', x: t.x, y: t.y });
          this.game.events.push({ k: 'frost', x: t.x, y: t.y, r: -0.5 });
        }
        return;
      }
      if (e.button !== 0) return;
      if (e.altKey && me) {
        this.send({ k: 'ping', x: t.x, y: t.y });
        return;
      }
      if (this.placing && me) {
        const type = this.placing;
        if (type === 'wall' || type === 'spikes') {
          this.dragPaint = true;
          this.lastPaint = { x: -1, y: -1 };
          this.paintTo(t.tx, t.ty);
        } else if (this.canPlace(type, t.tx, t.ty)) {
          this.send({ k: 'place', type, x: t.tx, y: t.ty });
          if (!e.shiftKey) this.placing = null;
        }
        return;
      }
      const b = this.game.buildingAt(t.tx, t.ty);
      if (me && !me.alive && b) this.send({ k: 'ghost', id: b.id });
      this.selected = b ? b.id : 0;
    });
    this.on(window, 'mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.panning) {
        const S = this.renderer.scale * 16;
        this.renderer.cam.x = this.panning.cx - ((e.clientX - this.panning.x) * this.renderer.dpr) / S;
        this.renderer.cam.y = this.panning.cy - ((e.clientY - this.panning.y) * this.renderer.dpr) / S;
        this.renderer.clampCam();
      }
      if (this.dragPaint) {
        const t = this.tileAt(e.clientX, e.clientY);
        if (t.tx !== this.lastPaint.x || t.ty !== this.lastPaint.y) this.paintTo(t.tx, t.ty);
      }
    });
    this.on(window, 'mouseup', () => {
      this.panning = null;
      this.dragPaint = false;
    });
    this.on(canvas, 'wheel', (e) => {
      e.preventDefault();
      this.renderer.zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
    });
    this.on(window, 'keydown', (e) => {
      if (document.activeElement === this.hud.chatIn) return;
      if (screen) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === 'enter') {
        e.preventDefault();
        this.hud.chatIn.focus();
        return;
      }
      if (k === 'escape') {
        this.placing = null;
        this.selected = 0;
        return;
      }
      if (DEV && !this.online && e.key === ']') this.game.debugNextWave();
      if (DEV && !this.online && e.key === '[' && this.me) this.me.gold += 500;
      const idx = TOWER_TYPES.findIndex((t) => BUILDINGS[t].hotkey === e.key);
      if (idx >= 0) this.togglePlacing(TOWER_TYPES[idx]);
      else if (k === 'q') this.send({ k: 'ability' });
      else if (k === 'u') this.upgrade();
      else if (k === 'x' || k === 'delete') this.sell();
      else if (k === 'r') this.send({ k: 'ready' });
      else if (k === 'g') {
        const t = this.tileAt(this.mouse.x, this.mouse.y);
        this.send({ k: 'ping', x: t.x, y: t.y });
      } else if (k === ' ') {
        e.preventDefault();
        const me = this.me;
        if (me) {
          const c = this.game.coreCenter(me.base);
          this.renderer.cam.x = c.x;
          this.renderer.cam.y = c.y - 1;
        }
      }
    });
    this.on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this.on(window, 'blur', () => this.keys.clear());
  }

  private on<K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void): void {
    target.addEventListener(type, fn as EventListener);
    this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
  }

  /** Dev hook: run the sim forward and draw one frame, even if the tab is in the background. */
  debugAdvance(seconds: number): void {
    if (this.online) {
      this.advance(seconds);
    } else {
      for (let t = 0; t < seconds; t += TICK) this.game.update(TICK);
    }
    this.renderer.render(TICK, { hoverX: -99, hoverY: -99, placing: this.placing, selected: this.selected, ghost: false });
    this.hud.update(this.placing, this.selected);
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const real = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    const pan = (18 / this.renderer.zoom) * real;
    const k = this.keys;
    if (k.has('a') || k.has('arrowleft')) this.renderer.cam.x -= pan;
    if (k.has('d') || k.has('arrowright')) this.renderer.cam.x += pan;
    if (k.has('w') || k.has('arrowup')) this.renderer.cam.y -= pan;
    if (k.has('s') || k.has('arrowdown')) this.renderer.cam.y += pan;
    this.renderer.clampCam();

    this.advance(real);

    if (this.selected && !this.game.buildings.has(this.selected)) this.selected = 0;
    if (this.me && !this.me.alive) this.placing = null;
    const t = this.tileAt(this.mouse.x, this.mouse.y);
    this.renderer.render(real * (this.online ? 1 : this.speed), {
      hoverX: t.x, hoverY: t.y, placing: this.placing, selected: this.selected, ghost: !!this.me && !this.me.alive,
    });
    this.hud.update(this.placing, this.selected);

    if (this.game.result && !this.resultShown) {
      this.resultShown = true;
      window.setTimeout(() => {
        if (current === this) showResult(this);
      }, 2500);
    }
  };
}

showLobby();
