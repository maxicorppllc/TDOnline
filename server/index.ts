// TD Online game server: matchmaking queues, authoritative match loops, spectating.
//
//   node server/index.ts         serve the built client from dist/ plus the game on PORT (default 8787)
//   node server/index.ts --dev   same, but the client is served live by Vite with hot reload (PORT default 5173)

import http from 'node:http';
import { connect as netConnect } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { Game } from '../src/game.ts';
import type { Command } from '../src/game.ts';
import { TICK } from '../src/config.ts';
import {
  CHECKSUM_EVERY, MAP_SIZES, PARTY_CODE_CHARS, PARTY_CODE_LEN, QUEUE_WAIT, RECONNECT_GRACE, TICKS_PER_BATCH, cleanCode,
} from '../src/protocol.ts';
import type { ClientMsg, LiveMatch, ServerMsg } from '../src/protocol.ts';

const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? (DEV ? 5173 : 8787));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ clients

interface Client {
  ws: WebSocket;
  id: number;
  name: string;
  token: string;
  queue: Queue | null;
  party: Party | null;
  match: Match | null;
  pid: number;
  /** Wrong party codes tried on this connection; guessing codes is cut off after a few. */
  badJoins: number;
  /** Simple flood control: commands allowed this second. */
  budget: number;
  /** Messages of any kind this second. */
  msgs: number;
  /** Snapshots are big, so each client gets at most one every few seconds. */
  lastSnap: number;
  snapTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_CLIENTS = 300;
const MAX_MATCHES = 40;
const SNAPSHOT_GAP_MS = 3000;
const MAX_PARTY = Math.max(...MAP_SIZES);
/** An empty party stays joinable this long, so a host who refreshes can get back in. */
const PARTY_KEEP_MS = 60_000;
const MAX_BAD_JOINS = 10;

let nextClientId = 1;
const clients = new Set<Client>();

function send(c: Client, msg: ServerMsg): void {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
}

function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16) : '';
  return s || 'Builder';
}

// ------------------------------------------------------------------ queues

class Queue {
  size: number;
  members: Client[] = [];
  startAt = 0;
  votes = new Set<Client>();

  constructor(size: number) {
    this.size = size;
  }

  add(c: Client): void {
    if (this.members.includes(c)) return;
    if (!this.members.length) this.startAt = Date.now() + QUEUE_WAIT * 1000;
    this.members.push(c);
    c.queue = this;
    if (this.members.length >= this.size) this.launch();
    else this.broadcast();
  }

  remove(c: Client): void {
    this.members = this.members.filter((m) => m !== c);
    this.votes.delete(c);
    c.queue = null;
    this.broadcast();
  }

  vote(c: Client): void {
    this.votes.add(c);
    if (this.votes.size >= this.members.length) this.launch();
    else this.broadcast();
  }

  check(): void {
    if (!this.members.length || Date.now() < this.startAt) return;
    // Server at capacity: keep everyone queued a little longer.
    if (matches.size >= MAX_MATCHES) this.startAt = Date.now() + 5000;
    else this.launch();
  }

  broadcast(): void {
    const startsIn = Math.max(0, Math.ceil((this.startAt - Date.now()) / 1000));
    for (const m of this.members) {
      send(m, { k: 'queue', size: this.size, names: this.members.map((x) => x.name), startsIn, votes: this.votes.size });
    }
  }

  private launch(): void {
    const members = this.members.slice(0, this.size);
    this.members = this.members.slice(this.size);
    this.votes.clear();
    for (const m of members) m.queue = null;
    if (this.members.length) this.startAt = Date.now() + QUEUE_WAIT * 1000;
    new Match(this.size, members);
  }
}

const queues = new Map(MAP_SIZES.map((n) => [n, new Queue(n)]));

// ------------------------------------------------------------------ parties

const parties = new Map<string, Party>();

function newCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < PARTY_CODE_LEN; i++) code += PARTY_CODE_CHARS[Math.floor(Math.random() * PARTY_CODE_CHARS.length)];
    if (!parties.has(code)) return code;
  }
}

/**
 * Friends who joined through one invite link. The first member is the host, who
 * picks the map size and starts; bots take the seats nobody fills. The party
 * outlives its matches, so the same group can go again.
 */
class Party {
  code = newCode();
  size: number;
  members: Client[] = [];
  emptySince = 0;

  constructor(size: number) {
    this.size = size;
    parties.set(this.code, this);
  }

  get host(): Client | undefined {
    return this.members[0];
  }

  add(c: Client): void {
    if (this.members.includes(c)) return;
    this.members.push(c);
    c.party = this;
    this.emptySince = 0;
    // Grow the map to fit everyone.
    if (this.size < this.members.length) this.size = MAP_SIZES.find((n) => n >= this.members.length) ?? MAX_PARTY;
    this.broadcast();
  }

  remove(c: Client): void {
    this.members = this.members.filter((m) => m !== c);
    c.party = null;
    if (!this.members.length) this.emptySince = Date.now();
    this.broadcast();
  }

  /** Whether a member is free to be put into a new match. */
  free(c: Client): boolean {
    return !c.match || c.pid < 0 || c.match.game.phase === 'over';
  }

  start(c: Client): void {
    if (c !== this.host) return;
    const going = this.members.filter((m) => this.free(m));
    if (!going.length) return;
    if (matches.size >= MAX_MATCHES) {
      send(c, { k: 'error', text: 'The server is busy right now. Try again in a few seconds.' });
      return;
    }
    // Pull anyone still looking at the last match's results into the new one.
    for (const m of going) {
      m.match?.drop(m, true);
      m.match = null;
      m.pid = -1;
    }
    console.log(`party ${this.code}: starting a ${this.size}-player match`);
    new Match(this.size, going);
  }

  broadcast(): void {
    const members = this.members.map((m) => ({ name: m.name, host: m === this.host, playing: !this.free(m) }));
    this.members.forEach((m, you) => send(m, { k: 'party', code: this.code, size: this.size, members, you }));
  }
}

// ------------------------------------------------------------------ matches

let nextMatchId = 1;
const matches = new Map<number, Match>();

class Match {
  id = nextMatchId++;
  size: number;
  game: Game;
  /** Seat (player id) -> connected client, or null while disconnected. */
  seats = new Map<number, Client | null>();
  tokens = new Map<string, number>();
  dropTimers = new Map<number, ReturnType<typeof setTimeout>>();
  spectators = new Set<Client>();
  pending: [number, Command][] = [];
  batch: [number, number, Command][] = [];
  last = performance.now();
  acc = 0;
  overAt = 0;
  emptySince = 0;

  constructor(size: number, members: Client[]) {
    this.size = size;
    // Names must be unique within a match.
    const used = new Set<string>();
    const names = members.map((m) => {
      let n = m.name;
      for (let i = 2; used.has(n); i++) n = `${m.name.slice(0, 14)}${i}`;
      used.add(n);
      return n;
    });
    const opts = { players: size, humans: names, seed: Math.floor(Math.random() * 2 ** 31) };
    this.game = new Game(opts);
    matches.set(this.id, this);
    members.forEach((m, i) => {
      const pid = this.game.humanPids[i];
      this.seats.set(pid, m);
      this.tokens.set(m.token, pid);
      m.match = this;
      m.pid = pid;
      send(m, { k: 'start', match: this.id, opts, pid });
    });
    console.log(`match ${this.id}: ${size} seats, humans ${names.join(', ')}`);
  }

  get clients(): Client[] {
    return [...[...this.seats.values()].filter((c): c is Client => !!c), ...this.spectators];
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  command(c: Client, cmd: Command): void {
    if (c.pid < 0 || this.seats.get(c.pid) !== c || cmd.k === 'bot') return;
    this.pending.push([c.pid, cmd]);
  }

  step(): void {
    const g = this.game;
    const t = g.tick;
    for (const [pid, cmd] of this.pending) {
      g.apply(pid, cmd);
      this.batch.push([t, pid, cmd]);
    }
    this.pending = [];
    g.update(TICK);
    g.events.length = 0;
    if (g.tick % TICKS_PER_BATCH === 0) {
      this.broadcast({ k: 'ticks', upTo: g.tick, cmds: this.batch });
      this.batch = [];
    }
    if (g.tick % CHECKSUM_EVERY === 0) this.broadcast({ k: 'sum', tick: g.tick, sum: g.checksum() });
    if (g.phase === 'over' && !this.overAt) this.overAt = Date.now();
  }

  snapshotFor(c: Client): void {
    if (c.snapTimer) return;
    const wait = c.lastSnap + SNAPSHOT_GAP_MS - Date.now();
    const go = () => {
      c.snapTimer = null;
      if (c.match !== this) return;
      c.lastSnap = Date.now();
      send(c, { k: 'snapshot', match: this.id, snap: this.game.toSnapshot(), pid: c.pid });
    };
    if (wait > 0) c.snapTimer = setTimeout(go, wait);
    else go();
  }

  spectate(c: Client): void {
    this.spectators.add(c);
    c.match = this;
    c.pid = -1;
    this.snapshotFor(c);
  }

  /** A player's socket went away (or they left on purpose). */
  drop(c: Client, now: boolean): void {
    if (this.spectators.delete(c)) return;
    const pid = c.pid;
    if (this.seats.get(pid) !== c) return;
    this.seats.set(pid, null);
    const takeover = () => {
      this.dropTimers.delete(pid);
      if (this.seats.get(pid) === null) this.pending.push([pid, { k: 'bot', on: true }]);
    };
    if (now) takeover();
    else this.dropTimers.set(pid, setTimeout(takeover, RECONNECT_GRACE * 1000));
  }

  rejoin(c: Client, pid: number): void {
    const timer = this.dropTimers.get(pid);
    if (timer) clearTimeout(timer);
    this.dropTimers.delete(pid);
    this.seats.set(pid, c);
    c.match = this;
    c.pid = pid;
    if (this.game.players[pid].isBot) this.pending.push([pid, { k: 'bot', on: false }]);
    this.snapshotFor(c);
  }

  close(reason: string): void {
    this.broadcast({ k: 'ended', reason });
    for (const c of this.clients) {
      c.match = null;
      c.pid = -1;
    }
    for (const t of this.dropTimers.values()) clearTimeout(t);
    matches.delete(this.id);
    console.log(`match ${this.id} closed: ${reason}`);
  }

  info(): LiveMatch {
    const g = this.game;
    return {
      id: this.id, size: this.size, wave: g.wave, alive: g.aliveCount(), phase: g.phase,
      humans: g.players.filter((p) => !p.isBot).map((p) => p.name), spectators: this.spectators.size,
    };
  }
}

// ------------------------------------------------------------------ loops

const STEP_MS = TICK * 1000;
setInterval(() => {
  const now = performance.now();
  for (const m of matches.values()) {
    m.acc = Math.min(m.acc + (now - m.last), STEP_MS * 10);
    m.last = now;
    try {
      while (m.acc >= STEP_MS) {
        m.acc -= STEP_MS;
        m.step();
      }
    } catch (err) {
      // A bug in one match shouldn't take down everyone else's.
      console.error(`match ${m.id} crashed:`, err);
      m.close('The match hit an error and had to stop.');
      continue;
    }
    if (m.overAt && Date.now() - m.overAt > 30_000) m.close('The match is over.');
    else if (m.clients.length === 0) {
      if (!m.emptySince) m.emptySince = Date.now();
      else if (Date.now() - m.emptySince > 60_000) m.close('Everyone left.');
    } else m.emptySince = 0;
  }
}, 8);

setInterval(() => {
  for (const q of queues.values()) {
    q.check();
    q.broadcast();
  }
  for (const [code, p] of parties) {
    if (!p.members.length && Date.now() - p.emptySince > PARTY_KEEP_MS) parties.delete(code);
    else p.broadcast(); // keeps who's still in a match current
  }
  const lobby: ServerMsg = {
    k: 'lobby',
    online: clients.size,
    queues: Object.fromEntries([...queues].map(([n, q]) => [n, q.members.length])),
    matches: [...matches.values()].map((m) => m.info()),
  };
  for (const c of clients) {
    c.budget = 40;
    c.msgs = 0;
    if (!c.match && !c.queue && !c.party) send(c, lobby);
  }
}, 1000);

// ------------------------------------------------------------------ sockets

function onMessage(c: Client, msg: ClientMsg): void {
  switch (msg.k) {
    case 'hello': {
      c.name = cleanName(msg.name);
      c.token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
      send(c, { k: 'welcome', online: clients.size });
      // Back from a refresh or a dropped connection: return them to their seat.
      for (const m of matches.values()) {
        const pid = c.token ? m.tokens.get(c.token) : undefined;
        if (pid === undefined || m.game.phase === 'over') continue;
        const old = m.seats.get(pid);
        if (old && old !== c) {
          old.match = null;
          old.ws.close();
        }
        m.rejoin(c, pid);
        break;
      }
      c.party?.broadcast(); // new name
      break;
    }
    case 'queue': {
      const q = queues.get(Number(msg.size));
      if (!q || c.match || c.party) return;
      c.queue?.remove(c);
      q.add(c);
      break;
    }
    case 'unqueue':
      c.queue?.remove(c);
      break;
    case 'startNow':
      c.queue?.vote(c);
      break;
    case 'party': {
      const size = MAP_SIZES.includes(Number(msg.size)) ? Number(msg.size) : 8;
      c.queue?.remove(c);
      c.party?.remove(c);
      new Party(size).add(c);
      break;
    }
    case 'join': {
      const code = cleanCode(msg.code);
      const p = parties.get(code);
      if (p && p === c.party) return p.broadcast();
      if (!p) {
        const reason = ++c.badJoins > MAX_BAD_JOINS
          ? 'Too many wrong codes. Refresh the page to try again.'
          : `There's no party with the code ${code || '(blank)'}. It may have ended.`;
        return send(c, { k: 'noParty', reason });
      }
      if (c.badJoins > MAX_BAD_JOINS) return send(c, { k: 'noParty', reason: 'Too many wrong codes. Refresh the page to try again.' });
      if (p.members.length >= MAX_PARTY) return send(c, { k: 'noParty', reason: `That party is full (${MAX_PARTY} players).` });
      c.queue?.remove(c);
      c.party?.remove(c);
      p.add(c);
      break;
    }
    case 'partySize': {
      const p = c.party;
      const size = Number(msg.size);
      if (!p || p.host !== c || !MAP_SIZES.includes(size) || size < p.members.length) return;
      p.size = size;
      p.broadcast();
      break;
    }
    case 'partyStart':
      c.party?.start(c);
      break;
    case 'partyLeave':
      c.party?.remove(c);
      break;
    case 'cmd':
      if (c.match && c.budget-- > 0) c.match.command(c, msg.c);
      break;
    case 'spectate': {
      const m = matches.get(Number(msg.id));
      if (!m || c.match) return send(c, { k: 'error', text: 'That match has ended.' });
      c.queue?.remove(c);
      m.spectate(c);
      break;
    }
    case 'leave':
      if (c.match) {
        // Leaving on purpose gives the base to a bot for good; only a dropped connection gets it back.
        if (c.pid >= 0) c.match.tokens.delete(c.token);
        c.match.drop(c, true);
        c.match = null;
        c.pid = -1;
        c.party?.broadcast();
      }
      break;
    case 'resync':
      if (c.match) c.match.snapshotFor(c);
      break;
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
  };
  const raw = (req.url ?? '/').split('?')[0];
  if (raw === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${clients.size} online, ${matches.size} matches`);
    return;
  }
  const dist = path.join(ROOT, 'dist');
  let url = '/';
  try {
    url = decodeURIComponent(raw);
  } catch {
    // malformed escape: serve the page
  }
  let file = path.join(dist, url === '/' ? 'index.html' : url);
  // Only ever serve files inside dist/; anything else gets the page.
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('No client build found. Run `npm run build` first, or use `npm run dev`.');
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// One port for everything. In dev, Vite runs inside this server as middleware
// (page + hot reload); otherwise the built client is served from dist/.
const server = http.createServer();
server.on('clientError', (_err, socket) => socket.destroy());
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = serveStatic;
if (DEV) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server } },
  });
  handler = (req, res) => vite.middlewares(req, res);
}
server.on('request', (req, res) => handler(req, res));

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  // Compress larger messages; snapshots shrink a lot.
  perMessageDeflate: { threshold: 1024 },
});
server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').split('?')[0] === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (!DEV) {
    socket.destroy(); // in dev, Vite's hot-reload socket handles the rest
  }
});

wss.on('connection', (ws: WebSocket) => {
  if (clients.size >= MAX_CLIENTS) {
    ws.send(JSON.stringify({ k: 'error', text: 'The server is full. Try again in a bit.' } satisfies ServerMsg));
    ws.close();
    return;
  }
  const c: Client = {
    ws, id: nextClientId++, name: 'Builder', token: '', queue: null, party: null, match: null, pid: -1,
    badJoins: 0, budget: 40, msgs: 0, lastSnap: 0, snapTimer: null,
  };
  clients.add(c);
  ws.on('message', (data) => {
    if (++c.msgs > 120) {
      ws.close(1008, 'Too many messages');
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && typeof msg.k === 'string') onMessage(c, msg);
  });
  // Bad frames (oversized, malformed) raise 'error'; unhandled, that would crash the process.
  ws.on('error', () => ws.terminate());
  ws.on('close', () => {
    if (c.snapTimer) clearTimeout(c.snapTimer);
    clients.delete(c);
    c.queue?.remove(c);
    c.party?.remove(c);
    c.match?.drop(c, false);
  });
});

/** Whether something already accepts connections on host:port. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(300, () => { s.destroy(); resolve(false); });
  });
}

// Without an explicit PORT, step past ports other apps are using. Checking both
// IPv4 and IPv6 matters on Windows, where two servers can split one port between them.
let port = PORT;
while (!process.env.PORT && port < PORT + 10 && ((await answers('127.0.0.1', port)) || (await answers('::1', port)))) {
  console.log(`Port ${port} is in use, trying ${port + 1}...`);
  port++;
}
server.listen(port, () => {
  console.log(`TD Online on http://localhost:${port}${DEV ? ' (dev, hot reload on)' : ''}`);
});
