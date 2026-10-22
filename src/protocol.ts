// Messages between the browser and the game server.
//
// The server runs every match and is the clock: it collects player commands,
// applies them at a tick, and streams "tick N happened, with these commands" to
// everyone in the match. Each browser runs its own copy of the simulation from
// that stream, so only player commands cross the network, never the horde.
// Spectators and reconnecting players get a full snapshot first.

import type { Command, GameOptions, Snapshot } from './game.ts';

export const MAP_SIZES = [4, 8, 16];
/** Seconds the queue waits for more humans before bots fill the empty seats. */
export const QUEUE_WAIT = 20;
/** Seconds a disconnected player has to come back before a bot takes the seat. */
export const RECONNECT_GRACE = 15;
export const TICKS_PER_BATCH = 3;
export const CHECKSUM_EVERY = 90;

export interface LiveMatch {
  id: number;
  size: number;
  wave: number;
  alive: number;
  phase: string;
  humans: string[];
  spectators: number;
}

export type ClientMsg =
  | { k: 'hello'; name: string; token: string }
  | { k: 'queue'; size: number }
  | { k: 'unqueue' }
  | { k: 'startNow' }
  | { k: 'cmd'; c: Command }
  | { k: 'spectate'; id: number }
  | { k: 'leave' }
  | { k: 'resync' };

export type ServerMsg =
  | { k: 'welcome'; online: number }
  | { k: 'lobby'; online: number; queues: Record<number, number>; matches: LiveMatch[] }
  | { k: 'queue'; size: number; names: string[]; startsIn: number; votes: number }
  | { k: 'start'; match: number; opts: GameOptions; pid: number }
  | { k: 'snapshot'; match: number; snap: Snapshot; pid: number }
  /** Ticks up to `upTo` have run; cmds are [tick, playerId, command], applied before that tick's update. */
  | { k: 'ticks'; upTo: number; cmds: [number, number, Command][] }
  | { k: 'sum'; tick: number; sum: number }
  | { k: 'ended'; reason: string }
  | { k: 'error'; text: string };
