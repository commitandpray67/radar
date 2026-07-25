import { describe, it, expect } from 'vitest';
import { extractPositions } from './positions';
import type { DemoSource, Row, Columns } from './source';
import type { ParsedRound } from './types';

function round(n: number, start: number, end: number, freeze = start): ParsedRound {
  return {
    round_number: n, start_tick: start, end_tick: end, freeze_end_tick: freeze,
    winner_team: 'CT', win_reason: '', ct_score: 0, t_score: 0,
    bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null,
    is_knife_round: false, ct_equip_value: 0, t_equip_value: 0,
  };
}

/** Build a columnar source from an array of row objects. */
function columnarSource(rows: Row[]): DemoSource {
  return {
    parseHeader: () => ({}),
    parseEvent: (): Row[] => [],
    parseTicks: (): Row[] => [],
    parseTicksColumnar: (): Columns => {
      const cols: Columns = {};
      const keys = new Set<string>();
      rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
      keys.forEach((k) => { cols[k] = rows.map((r) => r[k]); });
      return cols;
    },
    parseGrenades: (): Row[] => [],
  };
}

describe('extractPositions', () => {
  const noop = () => {};

  it('samples, maps ticks to rounds, and drops junk rows', () => {
    // Round 1: freeze_end 8, end 24, sampleRate 8 → sampled ticks {8,16,24}.
    const rounds = [round(1, 0, 24, 8)];
    const src = columnarSource([
      { tick: 8, steamid: 111, X: 10, Y: 20, Z: 5, team_num: 3, is_alive: true, yaw: 90 },
      { tick: 16, steamid: 222, X: -5, Y: 8, Z: 1, team_num: 2, is_alive: false, yaw: 0 },
      { tick: 16, steamid: 0, X: 1, Y: 1, Z: 1, team_num: 3, is_alive: true },   // steamid 0 → drop
      { tick: 8, steamid: 333, X: 0, Y: 0, Z: 0, team_num: 3, is_alive: true },  // unspawned → drop
      { tick: 999, steamid: 444, X: 3, Y: 3, Z: 3, team_num: 2, is_alive: true },// tick not in round → drop
    ]);
    const positions = extractPositions(src, rounds, 8, noop);
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ tick: 8, round_number: 1, player_id: 111, team_num: 3, is_alive: 1, yaw: 90 });
    expect(positions[1]).toMatchObject({ tick: 16, player_id: 222, is_alive: 0 });
  });

  it('returns [] when there are no rounds', () => {
    expect(extractPositions(columnarSource([]), [], 8, noop)).toEqual([]);
  });
});
