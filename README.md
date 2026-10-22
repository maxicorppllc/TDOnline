# TD Online (prototype)

Co-op tower defense in the browser. Queue for a map size, get two minutes to build,
then the horde pours out of the central portal and rushes every base at once.
A miniboss hits every base every 5 waves. When a base falls, its share of the horde
moves on to its neighbours. The more bases that survive all 30 waves, the bigger
everyone's reward.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. That one command runs the game server and serves the
client with hot reload on the same port.

- **Find match** joins the online queue. Other players in the same queue land in
  your match; after 20 seconds (or when everyone clicks *Start now*), bots fill
  the empty seats.
- **Practice offline** is you plus bots, entirely in the browser. Add `?dev` to
  the URL for cheat keys there: `]` brings the next wave forward, `[` gives 500 gold.
- **Live matches** in the lobby can be watched as a spectator.

To try multiplayer on one machine, open the page in two browser tabs (each tab is
its own player) and queue both for the same map size.

> **Windows PowerShell:** if `npm` says "running scripts is disabled on this system",
> type `npm.cmd` instead (`npm.cmd run dev`). It's the same command without the
> PowerShell wrapper that the execution policy blocks.

### Production

```bash
npm run build
npm start
```

Serves the built client and the game on one port (`PORT`, default 8787).

## Play with friends over the internet

### From your PC (free, no account)

Double-click **`share.cmd`**. It builds the game, starts the server and opens a
Cloudflare quick tunnel. Send friends the `https://….trycloudflare.com` link it
prints. Keep the window open while you play; closing it stops hosting.

- The link changes every time you run it.
- Your PC is the server, so friends play only while it's on and the window is open.
- Needs `cloudflared` (`winget install Cloudflare.cloudflared`).
- Visitors only ever reach the game: the built page and the game's WebSocket.
  The dev server (`npm run dev`) is never exposed.

### Permanent hosting

Any host that runs Node 24 (or Docker) and allows WebSockets works. The server
reads `PORT`, serves everything on it, and answers `/health` for health checks.

- **Render** (free tier, sleeps when idle): push this folder to a GitHub repo, then
  in Render choose *New → Blueprint* and pick the repo. `render.yaml` sets it up.
- **Fly.io, Railway or a VPS**: use the `Dockerfile` (`fly launch` picks it up).

All matches live in the server's memory, so restarting or redeploying ends any
matches in progress. That's fine for a prototype.

## Controls

| Key | Action |
| --- | --- |
| `1`–`6` | Pick wall, archer, cannon, frost, tesla, spikes. Click to place (Shift keeps placing) |
| Drag | Paint walls and spike traps |
| Right-click | Move your builder / cancel placement |
| `Q` | Builder shockwave |
| `U` / `X` | Upgrade / sell the selected building |
| `R` | Ready up (the build phase ends when every human is ready) |
| `WASD`, middle-drag, wheel | Pan and zoom |
| `Space` | Jump to your base |
| `G` or Alt+click | Ping the map |
| `Enter` | Chat |

## How online play works

The server runs every match and acts as the clock. Players send commands
("place an archer tower here"); the server applies them at a tick and streams
"tick N happened, with these commands" to everyone in the match. Each browser
runs its own identical copy of the simulation from that stream, so only player
commands cross the network, never the horde itself.

- Every 3 seconds the server sends a checksum of its copy. A browser whose copy
  has drifted asks for a full snapshot and carries on from that.
- Spectators and players coming back from a refresh get a snapshot, then the stream.
- A disconnected player has 15 seconds to come back before a bot takes over their base.
  Coming back later hands the base back.

## Layout

- `src/game.ts`: the match simulation (no DOM), shared by browser and server
- `src/protocol.ts`: messages between browser and server
- `server/index.ts`: queues, match loops, spectating, reconnects, static files
- `src/net.ts`: the browser's connection to the server
- `src/pathing.ts`: per-base flow fields; buildings are costly to path through rather than impassable, so the horde walks around your maze or smashes through it
- `src/bots.ts`: bot players
- `src/config.ts`: every tunable number (towers, enemies, waves, minibosses, economy)
- `src/sprites.ts`, `src/terrain.ts`: pixel art generated in code
- `src/render.ts`: canvas renderer, effects and night lighting
- `src/ui.ts`, `src/main.ts`: HUD, lobby, queue, results

## Tools

- `npm run balance -- 4 8`: plays 4 all-bot 8-player matches headless and reports when bases fall
- `npm run netcheck`: checks that two copies of a match stay identical, and that a
  saved-and-restored match carries on identically (what online play relies on)
- `npm run typecheck`
