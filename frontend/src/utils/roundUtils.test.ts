import { describe, it, expect } from 'vitest';
import {
  toRangeString,
  classifyEco,
  getPistolRoundNumbers,
  classifyRoundEco,
  getRoundsForEcoClass,
  toggleEcoRounds,
  sideForRound,
  sideSwapsBeforeRound,
  getTeamEcoMatches,
  getHalftimeRound,
  getDisplaySideScore,
} from './roundUtils';
import type { RoundInfo, PlayerInfo, TeamSessionDetail } from '../types';

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

describe('sideForRound — halftime + overtime swaps', () => {
  it('keeps the initial side for the first half', () => {
    expect(sideForRound('CT', 0)).toBe('CT');   // round 1
    expect(sideForRound('CT', 11)).toBe('CT');  // round 12
    expect(sideForRound('T', 5)).toBe('T');
  });
  it('swaps for the second half of regulation', () => {
    expect(sideForRound('CT', 12)).toBe('T');   // round 13
    expect(sideForRound('CT', 23)).toBe('T');   // round 24
  });
  it('swaps back at the start of overtime and every 3 rounds after', () => {
    // OT1 first half (rounds 25–27): back to the initial side.
    expect(sideForRound('CT', 24)).toBe('CT');  // round 25
    expect(sideForRound('CT', 26)).toBe('CT');  // round 27
    // OT1 second half (rounds 28–30): swapped again.
    expect(sideForRound('CT', 27)).toBe('T');   // round 28
    expect(sideForRound('CT', 29)).toBe('T');   // round 30
    // OT2 first half (rounds 31–33): swapped again.
    expect(sideForRound('CT', 30)).toBe('CT');  // round 31
  });
  it('counts swaps monotonically across periods', () => {
    expect(sideSwapsBeforeRound(0)).toBe(0);
    expect(sideSwapsBeforeRound(12)).toBe(1);
    expect(sideSwapsBeforeRound(24)).toBe(2);   // round 25
    expect(sideSwapsBeforeRound(27)).toBe(3);   // round 28
    expect(sideSwapsBeforeRound(30)).toBe(4);   // round 31
  });
});

describe('getRoundsForEcoClass — overtime side scoping', () => {
  // 30-round match (regulation + one overtime), CT-value always "full".
  const rounds = Array.from({ length: 30 }, (_, i) => round(i + 1, 20000, 20000));

  it('scopes a CT-starter to their real CT rounds through overtime', () => {
    const ctPlayer = player(100, 'CT');
    const nums = getRoundsForEcoClass(rounds, 'CT', 'full', [ctPlayer]).map((r) => r.round_number);
    // CT rounds: 1–12 (pistol 1 excluded) and OT1 first half 25–27.
    expect(nums).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 25, 26, 27]);
    // The old single-swap logic would have wrongly excluded 25–27 (labelled T).
  });
});

describe('getTeamEcoMatches — overtime side classification', () => {
  function teamRound(demoId: string, n: number, ct: number, t: number): RoundInfo {
    return { ...round(n, ct, t), demo_id: demoId };
  }

  it('reads the correct side economy in overtime rounds', () => {
    // Team started CT. Opponent (T) has a full buy in OT round 25 while the
    // team (back on CT in OT1 first half) is on an eco.
    const demoId = 'm1';
    const rounds: RoundInfo[] = [];
    for (let n = 1; n <= 30; n++) {
      // CT economy full in regulation, but in OT round 25 CT (the team) ecos.
      const ct = n === 25 ? 500 : 20000;
      const t = n === 25 ? 20000 : 500;
      rounds.push(teamRound(demoId, n, ct, t));
    }
    const session = {
      demo_ids: [demoId],
      team_sides: { [demoId]: 'CT' },
      rounds,
      demos: [{ id: demoId, filename: 'm1.dem' }],
    } as unknown as TeamSessionDetail;

    // Round 25 is the team on CT with an eco — must be CT Eco, never T anything.
    const ctEco = getTeamEcoMatches(session, 'CT', 'eco');
    expect(ctEco).toContain(`${demoId}:25`);
    const tFull = getTeamEcoMatches(session, 'T', 'full');
    expect(tFull).not.toContain(`${demoId}:25`);
  });
});

describe('getTeamEcoMatches — real team_num overrides the overtime heuristic', () => {
  it('excludes an OT round the round-number heuristic mislabels as the wrong side', () => {
    const demoId = 'm1';
    const rounds: RoundInfo[] = Array.from({ length: 30 }, (_, i) => ({
      ...round(i + 1, 20000, 20000),
      demo_id: demoId,
    }));
    const session = {
      demo_ids: [demoId],
      team_sides: { [demoId]: 'T' }, // team started T
      rounds,
      demos: [{ id: demoId, filename: 'm1.dem' }],
      core_roster: ['100', '101'],
      extended_roster: ['100', '101'],
    } as unknown as TeamSessionDetail;

    // Heuristic (no data): round 28 is labelled CT for a T-starting team.
    expect(getTeamEcoMatches(session, 'CT', 'full')).toContain(`${demoId}:28`);

    // Real team_num data says the roster was actually on T in round 28.
    const sideMap = { [demoId]: { '28': { '100': 'T', '101': 'T' } } } as const;
    expect(getTeamEcoMatches(session, 'CT', 'full', sideMap)).not.toContain(`${demoId}:28`);
    expect(getTeamEcoMatches(session, 'T', 'full', sideMap)).toContain(`${demoId}:28`);
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

describe('getHalftimeRound', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => round(i + 1, 0, 0));
  it('returns null at exactly 12 rounds (no round past the boundary)', () => {
    expect(getHalftimeRound(mk(12))).toBeNull();
  });
  it('returns the 12th round number once a 13th exists', () => {
    expect(getHalftimeRound(mk(13))).toBe(12);
  });
});

describe('getDisplaySideScore', () => {
  it('passes scores through in the first half', () => {
    expect(getDisplaySideScore(5, 12, 8, 3)).toEqual({ ct: 8, t: 3 });
  });
  it('swaps scores after halftime', () => {
    expect(getDisplaySideScore(13, 12, 8, 3)).toEqual({ ct: 3, t: 8 });
  });
  it('never swaps when there is no halftime', () => {
    expect(getDisplaySideScore(20, null, 8, 3)).toEqual({ ct: 8, t: 3 });
  });
});
