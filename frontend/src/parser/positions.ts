/**
 * Player position sampling — TypeScript port of `backend/parser/_positions.py`.
 *
 * Uses the columnar (`struct_of_arrays`) form of parseTicks: this is the
 * heaviest data path (~150k rows for a competitive demo) and columnar output
 * avoids the WASM boundary materializing an object per row.
 */

import type { DemoSource } from './source';
import { iterColumns } from './source';
import type { ParsedPosition, ParsedRound, ProgressFn } from './types';
import { toFloat, toInt } from './utils';

const POSITION_PROPS = ['X', 'Y', 'Z', 'yaw', 'team_num', 'is_alive', 'steamid'];

export function extractPositions(
  source: DemoSource,
  rounds: ParsedRound[],
  sampleRate: number,
  progress: ProgressFn,
): ParsedPosition[] {
  if (rounds.length === 0) return [];

  // Sampled tick set + tick→round map (identical construction to Python).
  const allTicks: number[] = [];
  const tickToRound = new Map<number, number>();
  for (const r of rounds) {
    const start = Math.max(r.start_tick, r.freeze_end_tick);
    for (let t = start; t <= r.end_tick; t += sampleRate) {
      allTicks.push(t);
      if (!tickToRound.has(t)) tickToRound.set(t, r.round_number);
    }
  }
  if (allTicks.length === 0) return [];

  progress(0.25, `Requesting ${allTicks.length.toLocaleString()} position ticks`);

  let cols;
  try {
    cols = source.parseTicksColumnar(POSITION_PROPS, allTicks);
  } catch {
    return [];
  }

  progress(0.6, 'Processing position rows');

  const positions: ParsedPosition[] = [];
  for (const row of iterColumns(cols)) {
    const rawId = row.steamid;
    // steamid 0 / missing → skip (not a real player entity).
    const steamId = toInt(rawId, 0);
    if (steamId === 0) continue;

    const tick = toInt(row.tick ?? 0);
    const rn = tickToRound.get(tick) ?? 0;
    if (rn === 0) continue;

    const x = toFloat(row.X ?? 0);
    const y = toFloat(row.Y ?? 0);
    const z = toFloat(row.Z ?? 0);
    if (x === 0 && y === 0 && z === 0) continue; // not yet spawned

    positions.push({
      tick,
      round_number: rn,
      player_id: steamId,
      x,
      y,
      z,
      team_num: toInt(row.team_num ?? 0),
      is_alive: row.is_alive ? 1 : 0,
      yaw: toFloat(row.yaw, 0.0),
    });
  }

  return positions;
}
