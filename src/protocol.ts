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
/** Party codes: no vowels (so no accidental words) and nothing easy to misread, like O/0 or I/1. */
export const PARTY_CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export const PARTY_CODE_LEN = 5;

/** Turns whatever someone typed or pasted into a party code. */
export function cleanCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, PARTY_CODE_LEN) : '';
}

export interface LiveMatch {
  id: number;
  size: number;
  wave: number;
  alive: number;
  phase: string;
  humans: string[];
  spectators: number;
}

export interface PartyMember {
  name: string;
  host: boolean;
  /** Still playing a match, so the next start goes ahead without them. */
  playing: boolean;
}

export type ClientMsg =
  | { k: 'hello'; name: string; token: string }
  | { k: 'queue'; size: number }
  | { k: 'unqueue' }
  | { k: 'startNow' }
  /** Make a new party (you're the host), or join one from an invite link or code. */
  | { k: 'party'; size: number }
  | { k: 'join'; code: string }
  /** Host only. */
  | { k: 'partySize'; size: number }
  | { k: 'partyStart' }
  | { k: 'partyLeave' }
  | { k: 'cmd'; c: Command }
  | { k: 'spectate'; id: number }
  | { k: 'leave' }
  | { k: 'resync' };

export type ServerMsg =
  | { k: 'welcome'; online: number }
  | { k: 'lobby'; online: number; queues: Record<number, number>; matches: LiveMatch[] }
  | { k: 'queue'; size: number; names: string[]; startsIn: number; votes: number }
  /** `you` is your index in `members`. */
  | { k: 'party'; code: string; size: number; members: PartyMember[]; you: number }
  /** The party you asked for doesn't exist (any more) or is full. */
  | { k: 'noParty'; reason: string }
  | { k: 'start'; match: number; opts: GameOptions; pid: number }
  | { k: 'snapshot'; match: number; snap: Snapshot; pid: number }
  /** Ticks up to `upTo` have run; cmds are [tick, playerId, command], applied before that tick's update. */
  | { k: 'ticks'; upTo: number; cmds: [number, number, Command][] }
  | { k: 'sum'; tick: number; sum: number }
  | { k: 'ended'; reason: string }
  | { k: 'error'; text: string };
