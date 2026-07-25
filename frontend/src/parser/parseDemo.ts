/**
 * parseDemo — orchestration, TypeScript port of
 * `backend/parser/demo_parser.py::parse_demo`.
 *
 * Runs against a DemoSource (the WASM adapter in production, a fake in tests)
 * and returns the normalised ParsedDemo. Extraction order matches Python so
 * downstream invariants (e.g. initial_team override from positions) hold.
 */

import type { DemoSource } from './source';
import type { ParsedDemo, ParsedPlayer, ProgressFn } from './types';
import { POSITION_SAMPLE_RATE } from './types';
import { extractRounds, inferInitialTeams } from './rounds';
import { extractPlayers } from './players';
import { extractPositions } from './positions';
import { extractEvents, extractEconomy, extractPlayerStateEvents } from './events';
import { extractGrenades } from './grenades';
import { toFloat, toInt } from './utils';

export function parseDemo(
  source: DemoSource,
  opts: { sampleRate?: number; progress?: ProgressFn } = {},
): ParsedDemo {
  const sampleRate = opts.sampleRate ?? POSITION_SAMPLE_RATE;
  const progress: ProgressFn = opts.progress ?? (() => {});

  // ---- Header / match info ----------------------------------------------
  progress(0.02, 'Reading header');
  const header = source.parseHeader();
  const mapName = String(header.map_name ?? 'unknown');
  const playbackTicks = toInt(header.playback_ticks ?? 0);
  const playbackTime = toFloat(header.playback_time ?? 1, 1) || 1;
  const tickRate = playbackTicks > 0 && playbackTime > 0
    ? Math.round((playbackTicks / playbackTime) * 100) / 100
    : 64.0;

  // ---- Rounds ------------------------------------------------------------
  progress(0.05, 'Extracting round boundaries');
  const rounds = extractRounds(source, tickRate);

  // ---- Player roster -----------------------------------------------------
  progress(0.15, 'Extracting player roster');
  let players = extractPlayers(source, rounds);

  // ---- Positions ---------------------------------------------------------
  progress(0.2, 'Sampling player positions');
  const positions = extractPositions(source, rounds, sampleRate, progress);

  // ---- Events ------------------------------------------------------------
  progress(0.9, 'Extracting game events');
  const events = extractEvents(source, rounds, mapName);

  // ---- Grenades ----------------------------------------------------------
  progress(0.92, 'Extracting grenade events');
  const grenades = extractGrenades(source, rounds, tickRate);

  // ---- Economy (mutates rounds in place) --------------------------------
  progress(0.93, 'Extracting economy data');
  extractEconomy(source, rounds);

  // ---- Player state events ----------------------------------------------
  progress(0.94, 'Extracting player state events');
  const playerStateEvents = extractPlayerStateEvents(source, rounds, tickRate);

  // ---- Correct initial_team from live position data ----------------------
  progress(0.95, 'Correcting initial team assignments');
  const initialTeams = inferInitialTeams(positions, rounds);
  players = players.map((p): ParsedPlayer => ({
    ...p,
    initial_team: initialTeams.get(p.player_id) ?? p.initial_team,
  }));

  progress(1.0, 'Parsing complete');
  return {
    matchInfo: { map_name: mapName, tick_rate: tickRate, total_ticks: playbackTicks },
    rounds,
    players,
    positions,
    events,
    grenades,
    playerStateEvents,
  };
}
