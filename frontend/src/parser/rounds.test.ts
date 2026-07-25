import { describe, it, expect } from 'vitest';
import { extractRounds, inferInitialTeams } from './rounds';
import type { DemoSource, Row, Columns } from './source';
import type { ParsedPosition, ParsedRound } from './types';

/** Minimal fake DemoSource backed by a map of event-name → rows. */
function makeSource(events: Record<string, Row[]>): DemoSource {
  return {
    parseHeader: () => ({}),
    parseEvent: (name: string) => events[name] ?? [],
    parseTicks: (): Row[] => [],
    parseTicksColumnar: (): Columns => ({}),
    parseGrenades: (): Row[] => [],
  };
}

// 64-tick → MIN_ROUND_TICKS = 832. Use ~2000-tick rounds so they survive.
const R = 2000;

describe('extractRounds — pairing & filters', () => {
  it('pairs starts/ends, assigns freeze, parses winners', () => {
    const src = makeSource({
      round_start: [{ tick: 0 }, { tick: R }],
      round_end: [
        { tick: R - 10, winner: 'CT', reason: '9' },
        { tick: 2 * R, winner: '2', reason: '9' },
      ],
      round_freeze_end: [{ tick: 100 }, { tick: R + 100 }],
    });
    const rounds = extractRounds(src);
    expect(rounds.map((r) => r.round_number)).toEqual([1, 2]);
    expect(rounds[0]).toMatchObject({ start_tick: 0, end_tick: R - 10, freeze_end_tick: 100, winner_team: 'CT' });
    expect(rounds[1].winner_team).toBe('T'); // '2' → T
    expect(rounds[1].freeze_end_tick).toBe(R + 100);
  });

  it('drops reason=16 transition rounds and short rounds', () => {
    const src = makeSource({
      round_start: [{ tick: 0 }, { tick: R }, { tick: 2 * R }],
      round_end: [
        { tick: R - 10, winner: 'CT', reason: '16' },   // transition → dropped
        { tick: R + 200, winner: 'T', reason: '9' },     // ~200 ticks → short → dropped
        { tick: 3 * R, winner: 'CT', reason: '9' },      // kept
      ],
      round_freeze_end: [],
    });
    const rounds = extractRounds(src);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].winner_team).toBe('CT');
    expect(rounds[0].freeze_end_tick).toBe(2 * R); // no freeze event → falls back to start
  });
});

describe('extractRounds — bomb ticks & winner inference', () => {
  it('assigns bomb ticks and infers winner from bomb when missing', () => {
    const src = makeSource({
      round_start: [{ tick: 0 }, { tick: R }],
      round_end: [
        { tick: R - 10, winner: '', reason: '' },   // no winner → infer from explode
        { tick: 2 * R, winner: '', reason: '' },     // no winner → infer from defuse
      ],
      round_freeze_end: [],
      bomb_planted: [{ tick: 500 }, { tick: R + 500 }],
      bomb_exploded: [{ tick: 800 }],
      bomb_defused: [{ tick: R + 800 }],
    });
    const rounds = extractRounds(src);
    expect(rounds[0]).toMatchObject({ bomb_planted_tick: 500, bomb_exploded_tick: 800, winner_team: 'T', win_reason: '1' });
    expect(rounds[1]).toMatchObject({ bomb_planted_tick: R + 500, bomb_defused_tick: R + 800, winner_team: 'CT', win_reason: '7' });
  });
});

describe('extractRounds — knife detection', () => {
  it('flags a round where every kill is a knife kill', () => {
    const src = makeSource({
      round_start: [{ tick: 0 }, { tick: R }],
      round_end: [
        { tick: R - 10, winner: 'CT', reason: '9' },
        { tick: 2 * R, winner: 'T', reason: '9' },
      ],
      round_freeze_end: [],
      player_death: [
        { tick: 300, weapon: 'weapon_knife' },
        { tick: 400, weapon: 'knife_karambit' },
        { tick: R + 300, weapon: 'ak47' },   // round 2 has a gun kill
      ],
    });
    const rounds = extractRounds(src);
    expect(rounds[0].is_knife_round).toBe(true);
    expect(rounds[1].is_knife_round).toBe(false);
  });
});

describe('extractRounds — halftime score swap', () => {
  it('flips winner attribution after round 12', () => {
    // 13 rounds, all with winner field 'CT'.
    const starts: Row[] = [];
    const ends: Row[] = [];
    for (let i = 0; i < 13; i++) {
      starts.push({ tick: i * R });
      ends.push({ tick: i * R + (R - 10), winner: 'CT', reason: '9' });
    }
    const rounds = extractRounds(makeSource({ round_start: starts, round_end: ends, round_freeze_end: [] }));
    expect(rounds).toHaveLength(13);
    // Rounds 1–12: CT (starting side) wins → ct_score climbs to 12.
    expect(rounds[11]).toMatchObject({ round_number: 12, ct_score: 12, t_score: 0 });
    // Round 13 is post-halftime: a 'CT'-labelled win belongs to the team that started T.
    expect(rounds[12]).toMatchObject({ round_number: 13, ct_score: 12, t_score: 1 });
  });
});

describe('inferInitialTeams', () => {
  it('derives teams from the first non-knife round positions', () => {
    const rounds: ParsedRound[] = [
      { round_number: 1, start_tick: 0, end_tick: R, freeze_end_tick: 0, winner_team: 'CT', win_reason: '', ct_score: 0, t_score: 0, bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null, is_knife_round: true, ct_equip_value: 0, t_equip_value: 0 },
      { round_number: 2, start_tick: R, end_tick: 2 * R, freeze_end_tick: R, winner_team: 'T', win_reason: '', ct_score: 0, t_score: 0, bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null, is_knife_round: false, ct_equip_value: 0, t_equip_value: 0 },
    ];
    const pos = (round_number: number, player_id: number, team_num: number): ParsedPosition =>
      ({ tick: 0, round_number, player_id, x: 1, y: 1, z: 1, team_num, is_alive: 1, yaw: 0 });
    const positions = [
      pos(1, 100, 2), // knife round — ignored
      pos(2, 100, 3), // first non-knife round → CT
      pos(2, 200, 2), // → T
      pos(2, 100, 2), // duplicate for 100 → ignored (first wins)
    ];
    const teams = inferInitialTeams(positions, rounds);
    expect(teams.get(100)).toBe('CT');
    expect(teams.get(200)).toBe('T');
  });
});
