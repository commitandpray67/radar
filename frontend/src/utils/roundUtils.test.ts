import { describe, it, expect } from 'vitest';
import {
  toRangeString,
  classifyEco,
  getPistolRoundNumbers,
  classifyRoundEco,
  getRoundsForEcoClass,
  toggleEcoRounds,
} from './roundUtils';
import type { RoundInfo, PlayerInfo } from '../types';

function round(n: number, ct: number, t: number, opts: Partial<RoundInfo> = {}): RoundInfo {
  return {
    id: n,
    demo_id: 'd',
    round_number: n,
    start_tick: n * 1000,
    end_tick: n * 1000 + 500,
    freeze_end_tick: n * 1000 + 100,
    winner_team: 'CT',
    win_reason: '',
    ct_score: 0,
    t_score: 0,
    bomb_planted_tick: null,
    bomb_defused_tick: null,
    bomb_exploded_tick: null,
    is_knife_round: false,
    ct_equip_value: ct,
    t_equip_value: t,
    ...opts,
  };
}

function player(id: number, team: 'CT' | 'T'): PlayerInfo {
  return { id, demo_id: 'd', player_id: id, name: `p${id}`, initial_team: team };
}

describe('toRangeString', () => {
  it('collapses consecutive runs into ranges', () => {
    expect(toRangeString([2, 3, 4, 7])).toBe('2–4, 7');
  });
  it('handles single values and gaps', () => {
    expect(toRangeString([1, 3, 5])).toBe('1, 3, 5');
    expect(toRangeString([5])).toBe('5');
  });
  it('sorts unsorted input', () => {
    expect(toRangeString([3, 1, 2])).toBe('1–3');
  });
  it('returns empty string for empty input', () => {
    expect(toRangeString([])).toBe('');
  });
});

describe('classifyEco', () => {
  it('classifies by equipment-value thresholds', () => {
    expect(classifyEco(18000)).toBe('full');
    expect(classifyEco(20000)).toBe('full');
    expect(classifyEco(9000)).toBe('force');
    expect(classifyEco(17999)).toBe('force');
    expect(classifyEco(4000)).toBe('half');
    expect(classifyEco(3999)).toBe('eco');
    expect(classifyEco(0)).toBe('eco');
  });
});

describe('getPistolRoundNumbers', () => {
  it('returns first round of each half for a full match', () => {
    const rounds = Array.from({ length: 24 }, (_, i) => round(i + 1, 20000, 20000));
    expect(getPistolRoundNumbers(rounds)).toEqual([1, 13]);
  });
  it('returns only the opening pistol for a short match', () => {
    const rounds = Array.from({ length: 10 }, (_, i) => round(i + 1, 20000, 20000));
    expect(getPistolRoundNumbers(rounds)).toEqual([1]);
  });
});

describe('classifyRoundEco', () => {
  const rounds = Array.from({ length: 24 }, (_, i) => round(i + 1, 20000, 1000));
  const pistols = getPistolRoundNumbers(rounds);
  it('flags pistol rounds regardless of equipment value', () => {
    expect(classifyRoundEco(rounds[0], 'CT', pistols)).toBe('pistol');
    expect(classifyRoundEco(rounds[12], 'CT', pistols)).toBe('pistol');
  });
  it('classifies non-pistol rounds by the requested side value', () => {
    expect(classifyRoundEco(rounds[1], 'CT', pistols)).toBe('full');
    expect(classifyRoundEco(rounds[1], 'T', pistols)).toBe('eco');
  });
});

describe('getRoundsForEcoClass — player scoping', () => {
  // 24 rounds, CT always "full" by value (pistols still classify as pistol).
  const rounds = Array.from({ length: 24 }, (_, i) => round(i + 1, 20000, 20000));

  it('returns all matching rounds when no player is selected', () => {
    const nums = getRoundsForEcoClass(rounds, 'CT', 'full').map((r) => r.round_number);
    // Every round except the two pistols (1 and 13).
    expect(nums).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });

  it('restricts to rounds where a selected player was actually on that side', () => {
    // Player starts CT → CT for rounds 1–12, swaps to T for rounds 13–24.
    const ctPlayer = player(100, 'CT');
    const nums = getRoundsForEcoClass(rounds, 'CT', 'full', [ctPlayer]).map((r) => r.round_number);
    // Only first-half CT-full rounds (round 1 is a pistol, excluded).
    expect(nums).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('respects the halftime swap for the T side too', () => {
    const ctPlayer = player(100, 'CT'); // T in the second half
    const nums = getRoundsForEcoClass(rounds, 'T', 'full', [ctPlayer]).map((r) => r.round_number);
    // Second-half T-full rounds (round 13 is a pistol, excluded).
    expect(nums).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  });
});

describe('toggleEcoRounds', () => {
  const rounds = Array.from({ length: 24 }, (_, i) => round(i + 1, 20000, 20000));
  it('adds matching rounds when none are selected', () => {
    const next = toggleEcoRounds(rounds, 'CT', 'full', []);
    expect(next).toContain(2);
    expect(next).not.toContain(1); // pistol
  });
  it('removes matching rounds when all are already selected', () => {
    const all = getRoundsForEcoClass(rounds, 'CT', 'full').map((r) => r.round_number);
    const next = toggleEcoRounds(rounds, 'CT', 'full', all);
    expect(next).toEqual([]);
  });
});
