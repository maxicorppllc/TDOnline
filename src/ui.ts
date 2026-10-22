// The in-match HUD: resources, wave timer, build bar, selection panel, chat, minimap, banners.

import { BOSS_WAVES, BUILDINGS, ENEMIES, MAX_LEVEL, SELL_REFUND, TOTAL_WAVES, TOWER_TYPES, upgradeCost } from './config.ts';
import type { TowerType } from './config.ts';
import type { Game } from './game.ts';
import type { Renderer } from './render.ts';

export interface HudHandlers {
  selectTower(t: TowerType): void;
  ability(): void;
  upgrade(): void;
  sell(): void;
  ready(): void;
  leave(): void;
  speed(): void;
  sendChat(text: string): void;
  jumpTo(x: number, y: number): void;
}

const $ = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector(sel) as T;

function fmt(t: number): string {
  t = Math.max(0, Math.ceil(t));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

export class Hud {
  root: HTMLElement;
  chatIn: HTMLInputElement;
  private game: Game;
  private renderer: Renderer;
  private h: HudHandlers;
  private spectating: boolean;
  private chatSeen = 0;
  private chatTimes: number[] = [];
  private bannerTimer = 0;
  private lastSlow = 0;
  private miniCtx: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement;
  speedLabel = '1x';
  /** Shown in the corner: "Practice", "Online", "Reconnecting..." */
  netLabel = '';

  constructor(parent: HTMLElement, game: Game, renderer: Renderer, handlers: HudHandlers, spectating: boolean, online: boolean) {
    this.game = game;
    this.renderer = renderer;
    this.h = handlers;
    this.spectating = spectating;
    const root = (this.root = document.createElement('div'));
    root.id = 'hud';
    root.innerHTML = `
      <div id="gold" class="panel"><span class="coin"></span><span id="goldv">0</span></div>
      <div id="topbar" class="panel">
        <span id="wave"></span><span class="sep"></span>
        <span id="timer"></span><button id="ready" class="gold hidden">Ready (R)</button><span class="sep"></span>
        <span id="alive"></span><span class="sep boss-sep"></span>
        <span id="bossnext" class="boss-next"></span>
      </div>
      <div id="menu">
        <span id="netlabel"></span>
        <button id="speed" class="${online ? 'hidden' : ''}" title="Simulation speed (practice only)">1x</button>
        <button id="helpbtn">Controls</button>
        <button id="leave">Leave</button>
      </div>
      <div id="help" class="panel hidden">
        <div><kbd>1</kbd>-<kbd>6</kbd> pick a building, click to place</div>
        <div>Drag to paint walls and traps</div>
        <div><kbd>Right-click</kbd> move builder / cancel</div>
        <div><kbd>Q</kbd> builder shockwave</div>
        <div><kbd>U</kbd> upgrade, <kbd>X</kbd> sell selected</div>
        <div><kbd>WASD</kbd> / middle-drag to pan, wheel to zoom</div>
        <div><kbd>Space</kbd> jump to your base</div>
        <div><kbd>G</kbd> ping the map, <kbd>Enter</kbd> chat</div>
        <div><kbd>R</kbd> ready up during the build phase</div>
      </div>
      <div id="buildbar" class="panel"></div>
      <div id="tip" class="panel hidden"></div>
      <div id="sel" class="panel hidden"></div>
      <div id="ghostbar" class="panel hidden">You're a ghost now. Click any ally building to repair it (every 4s). You still share the survivor bonus.</div>
      <div id="chat">
        <div id="chatlog" class="faded"></div>
        <input id="chatin" maxlength="120" placeholder="Press Enter to chat" autocomplete="off" />
      </div>
      <div id="mini" class="panel"><canvas id="minic"></canvas></div>
      <div id="banner"><div class="big"></div><div class="sub"></div></div>
    `;
    parent.appendChild(root);
    this.chatIn = $(root, '#chatin');
    this.mini = $(root, '#minic');
    this.mini.width = game.size;
    this.mini.height = game.size;
    this.miniCtx = this.mini.getContext('2d') as CanvasRenderingContext2D;

    const bar = $(root, '#buildbar');
    if (spectating) {
      bar.classList.add('hidden');
      $(root, '#gold').classList.add('hidden');
    } else {
      for (const t of TOWER_TYPES) {
        const def = BUILDINGS[t];
        const b = document.createElement('button');
        b.className = 'slot';
        b.dataset.t = t;
        const icon = renderer.icon(t, game.human?.color ?? '#4aa3ff');
        const c = document.createElement('canvas');
        const sc = 2;
        c.width = icon.width;
        c.height = icon.height;
        c.style.width = `${icon.width * sc}px`;
        c.style.height = `${Math.min(icon.height * sc, 52)}px`;
        c.style.objectFit = 'contain';
        (c.getContext('2d') as CanvasRenderingContext2D).drawImage(icon, 0, 0);
        b.innerHTML = `<span class="key">${def.hotkey}</span>`;
        b.appendChild(c);
        const cost = document.createElement('span');
        cost.className = 'cost';
        cost.textContent = String(def.cost);
        b.appendChild(cost);
        b.onclick = () => this.h.selectTower(t);
        b.onmouseenter = () => this.tip(`<div class="name">${def.name} · ${def.cost} gold</div>${def.desc}${def.range ? `<br>Range ${def.range}, damage ${def.damage}` : ''}`);
        b.onmouseleave = () => this.tip(null);
        bar.appendChild(b);
      }
      const sep = document.createElement('div');
      sep.className = 'bar-sep';
      bar.appendChild(sep);
      const ab = document.createElement('button');
      ab.className = 'slot ability';
      ab.id = 'abil';
      ab.innerHTML = '<span class="key">Q</span><div class="icon-shock"></div><span class="cost">Shockwave</span><div class="cd hidden"></div>';
      ab.onclick = () => this.h.ability();
      ab.onmouseenter = () => this.tip('<div class="name">Shockwave</div>Your builder blasts and slows everything nearby. 25s cooldown.');
      ab.onmouseleave = () => this.tip(null);
      bar.appendChild(ab);
    }

    if (spectating) {
      this.chatIn.disabled = true;
      this.chatIn.placeholder = 'Spectators can only watch';
    }
    $(root, '#ready').onclick = () => this.h.ready();
    $(root, '#leave').onclick = () => this.h.leave();
    $(root, '#speed').onclick = () => this.h.speed();
    $(root, '#helpbtn').onclick = () => $(root, '#help').classList.toggle('hidden');
    this.chatIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = this.chatIn.value.trim();
        if (v) this.h.sendChat(v);
        this.chatIn.value = '';
        this.chatIn.blur();
      } else if (e.key === 'Escape') {
        this.chatIn.blur();
      }
    });
    this.chatIn.addEventListener('focus', () => $(root, '#chatlog').classList.remove('faded'));
    this.chatIn.addEventListener('blur', () => $(root, '#chatlog').classList.add('faded'));
    const jump = (e: MouseEvent) => {
      const r = this.mini.getBoundingClientRect();
      this.h.jumpTo(((e.clientX - r.left) / r.width) * game.size, ((e.clientY - r.top) / r.height) * game.size);
    };
    this.mini.addEventListener('mousedown', (e) => {
      jump(e);
      const move = (ev: MouseEvent) => jump(ev);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  destroy(): void {
    this.root.remove();
  }

  /** Swap in a resynced copy of the match. */
  setGame(g: Game): void {
    this.game = g;
    this.chatSeen = g.chat.length;
  }

  private tip(html: string | null): void {
    const t = $(this.root, '#tip');
    if (!html) { t.classList.add('hidden'); return; }
    t.innerHTML = html;
    t.classList.remove('hidden');
  }

  banner(text: string, sub: string, style: string): void {
    const b = $(this.root, '#banner');
    b.className = `${style} show`;
    $(b, '.big').textContent = text;
    $(b, '.sub').textContent = sub;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), 3200);
  }

  update(placing: TowerType | null, selected: number): void {
    const g = this.game;
    const now = performance.now();
    this.updateChat(now);
    if (now - this.lastSlow < 100) return;
    this.lastSlow = now;
    const h = g.human;
    const root = this.root;

    $(root, '#goldv').textContent = h ? String(h.gold) : '';
    $(root, '#wave').innerHTML = g.phase === 'build' ? '<b>Build phase</b>' : `Wave <b>${g.wave}</b>/${TOTAL_WAVES}`;
    const ready = $(root, '#ready');
    if (g.phase === 'build') {
      $(root, '#timer').innerHTML = `Portal opens in <b>${fmt(g.phaseTime)}</b>`;
      ready.classList.toggle('hidden', !h || h.ready);
    } else if (g.phase === 'waves') {
      const left = g.wave >= TOTAL_WAVES ? 'Final wave!' : `Next wave <b>${fmt(g.nextWaveIn)}</b>`;
      $(root, '#timer').innerHTML = `${left} · ${g.enemies.length} enemies`;
      ready.classList.add('hidden');
    } else {
      $(root, '#timer').textContent = 'Match over';
      ready.classList.add('hidden');
    }
    $(root, '#alive').innerHTML = `Bases alive <b>${g.aliveCount()}</b>/${g.players.length}`;
    const bw = g.nextBossWave();
    $(root, '#bossnext').textContent = bw ? `Miniboss wave ${bw}: ${ENEMIES[BOSS_WAVES[bw]].name}` : 'No more minibosses';
    $(root, '#speed').textContent = this.speedLabel;
    $(root, '#netlabel').textContent = this.netLabel;

    if (h && !this.spectating) {
      for (const el of root.querySelectorAll<HTMLElement>('.slot[data-t]')) {
        const t = el.dataset.t as TowerType;
        el.classList.toggle('on', placing === t);
        el.classList.toggle('poor', h.gold < BUILDINGS[t].cost);
        (el as HTMLButtonElement).disabled = !h.alive;
      }
      const ab = $(root, '#abil') as HTMLButtonElement;
      const cd = $(ab, '.cd');
      cd.classList.toggle('hidden', h.abilityCd <= 0);
      cd.textContent = String(Math.ceil(h.abilityCd));
      ab.disabled = !h.alive || h.builder.dead;
      $(root, '#ghostbar').classList.toggle('hidden', h.alive || g.phase === 'over');
      $(root, '#buildbar').classList.toggle('hidden', !h.alive);
    }

    const sel = $(root, '#sel');
    const b = selected ? g.buildings.get(selected) : undefined;
    if (!b) {
      sel.classList.add('hidden');
    } else {
      const def = BUILDINGS[b.type];
      const owner = g.players[b.owner];
      const mine = !!h && b.owner === h.id && h.alive;
      const st = g.stat(b);
      let html = `<div class="title">${def.name}${b.type !== 'core' ? ` · level ${b.level}` : ''}</div>`;
      html += `<div class="owner" style="color:${owner.color}">${esc(owner.name)}${mine ? ' (you)' : ''}</div>`;
      html += `<div class="row"><span>Health</span><span>${Math.ceil(b.hp)} / ${Math.round(b.maxHp)}</span></div>`;
      if (def.damage) html += `<div class="row"><span>Damage</span><span>${st.damage.toFixed(0)}${def.splash ? ' splash' : ''}${def.chain ? ` ×${def.chain} chain` : ''}</span></div>`;
      if (def.range) html += `<div class="row"><span>Range</span><span>${st.range.toFixed(1)}</span></div>`;
      if (!b.complete) html += `<div class="row"><span>Status</span><span>${b.started ? `building ${Math.floor(b.progress * 100)}%` : 'waiting for builder'}</span></div>`;
      if (mine && b.type !== 'core') {
        const canUp = b.complete && b.level < MAX_LEVEL;
        const upCost = canUp ? upgradeCost(b.type, b.level) : 0;
        const refund = b.started ? Math.floor(b.invested * SELL_REFUND) : b.invested;
        html += `<div class="btns"><button id="upbtn" ${!canUp || h!.gold < upCost ? 'disabled' : ''}>${canUp ? `Upgrade ${upCost} (U)` : b.level >= MAX_LEVEL ? 'Max level' : 'Upgrade'}</button><button id="sellbtn">Sell +${refund} (X)</button></div>`;
      }
      if (sel.dataset.html !== html) {
        sel.dataset.html = html;
        sel.innerHTML = html;
        const up = sel.querySelector<HTMLButtonElement>('#upbtn');
        if (up) up.onclick = () => this.h.upgrade();
        const sb = sel.querySelector<HTMLButtonElement>('#sellbtn');
        if (sb) sb.onclick = () => this.h.sell();
      }
      sel.classList.remove('hidden');
    }
    this.drawMinimap();
  }

  private updateChat(now: number): void {
    const g = this.game;
    const log = $(this.root, '#chatlog');
    while (this.chatSeen < g.chat.length) {
      const m = g.chat[this.chatSeen++];
      const div = document.createElement('div');
      div.className = 'msg' + (m.system ? ' sys' : '');
      div.innerHTML = m.system ? esc(m.text) : `<span style="color:${m.color}">${esc(m.name)}:</span> ${esc(m.text)}`;
      log.appendChild(div);
      this.chatTimes.push(now);
      while (log.children.length > 40) {
        log.removeChild(log.firstChild as Node);
        this.chatTimes.shift();
      }
    }
    const kids = log.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('old', now - this.chatTimes[i] > 12000 || i < kids.length - 9);
  }

  private drawMinimap(): void {
    const g = this.game;
    const m = this.miniCtx;
    m.drawImage(this.renderer.minimapBase, 0, 0);
    for (const b of g.buildings.values()) {
      if (!b.started) continue;
      m.fillStyle = b.type === 'wall' ? '#b8b4c8' : g.players[b.owner].color;
      m.fillRect(b.tx, b.ty, b.w, b.w);
    }
    for (const p of g.players) {
      const s = g.map.bases[p.base];
      m.fillStyle = p.alive ? p.color : '#3a3448';
      m.fillRect(s.tx - 2, s.ty - 2, 5, 5);
      m.fillStyle = '#0b0916';
      m.fillRect(s.tx - 1, s.ty - 1, 3, 3);
      m.fillStyle = p.alive ? p.color : '#3a3448';
      m.fillRect(s.tx, s.ty, 1, 1);
    }
    for (const e of g.enemies) {
      m.fillStyle = e.def.boss ? '#ffb02a' : '#ff3a4a';
      const r = e.def.boss ? 3 : 1;
      m.fillRect(Math.floor(e.x) - (r >> 1), Math.floor(e.y) - (r >> 1), r, r);
    }
    m.fillStyle = '#c08bff';
    m.fillRect(Math.floor(g.map.center) - 2, Math.floor(g.map.center) - 2, 4, 4);
    for (const p of g.pings) {
      m.strokeStyle = p.color;
      m.lineWidth = 1;
      m.beginPath();
      m.arc(p.x, p.y, 3 + (p.t % 1) * 6, 0, Math.PI * 2);
      m.stroke();
    }
    const tl = this.renderer.screenToWorld(0, 0);
    const br = this.renderer.screenToWorld(window.innerWidth, window.innerHeight);
    m.strokeStyle = 'rgba(255,255,255,0.8)';
    m.lineWidth = 1;
    m.strokeRect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(br.x - tl.x), Math.round(br.y - tl.y));
  }
}
