/**
 * Output contract for the in-browser parser — the TypeScript equivalent of
 * `backend/parser/_types.py::ParsedDemo`.
 *
 * The parser emits "raw" shapes: the existing app types minus the DB-only
 * fields (`id`, `demo_id`) that get assigned when a demo is written to
 * IndexedDB. Deriving from the app types with `Omit` guarantees the parser
 * output slots directly into the Zustand store and storage layer with no
 * adapter.
 */

import type {
  RoundInfo,
  PlayerInfo,
  PlayerPosition,
  GameEvent,
  GrenadeEvent,
  PlayerStateEvent,
} from '../types';

/** Bump when parse logic/schema changes — forces cached demos to re-parse.
 *  Mirrors `PARSER_VERSION` in `backend/parser/demo_parser.py` (v29). */
export const PARSER_VERSION = 29;

/** Ticks sampled per round for positions (64-tick × rate 8 ≈ 8 samples/sec). */
export const POSITION_SAMPLE_RATE = 8;

export interface MatchInfo {
  map_name: string;
  tick_rate: number;
  total_ticks: number;
}

export type ParsedRound = Omit<RoundInfo, 'id' | 'demo_id'>;
export type ParsedPlayer = Omit<PlayerInfo, 'id' | 'demo_id'>;
export type ParsedPosition = Omit<PlayerPosition, 'demo_id'>;
export type ParsedGameEvent = Omit<GameEvent, 'id' | 'demo_id'>;
export type ParsedGrenade = Omit<GrenadeEvent, 'id' | 'demo_id'>;
export type ParsedStateEvent = Omit<PlayerStateEvent, 'id' | 'demo_id'>;

export interface ParsedDemo {
  matchInfo: MatchInfo;
  rounds: ParsedRound[];
  players: ParsedPlayer[];
  positions: ParsedPosition[];
  events: ParsedGameEvent[];
  grenades: ParsedGrenade[];
  playerStateEvents: ParsedStateEvent[];
}

/** Progress callback: fraction in [0,1] + a human-readable message. */
export type ProgressFn = (fraction: number, message: string) => void;
