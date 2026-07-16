import { describe, it, expect } from 'vitest';
import { buildRoundInsights, summarizeSites, winRateByBuy } from './roundInsights';
import type { GameEvent, RoundInfo } from '../types';

function round(n: number, opts: Partial<RoundInfo> = {}): RoundInfo {
  return {
    id: n, demo_id: 'd', round_number: n,
    start_tick: 0, end_tick: 0, freeze_end_tick: 0,
    winner_team: 'CT', win_reason: 'elimination',
    ct_score: 0, t_score: 0,
    bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null,
    is_knife_round: false, ct_equip_value: 20000, t_equip_value: 20000,
    ...opts,
  };
}

function plant(rn: number, site: 'A' | 'B'): GameEvent {
  return {
    id: rn, demo_id: 'd', tick: 100, round_number: rn,
    event_type: 'bomb_planted', attacker_id: null, victim_id: null,
    weapon: site, headshot: 0,
  };
}

describe('buildRoundInsights', () => {
  it('resolves site, plant/defuse/explode and excludes knife rounds', () => {
    const rounds = [
      round(1, { bomb_planted_tick: 100, bomb_exploded_tick: 200, winner_team: 'T' }),
      round(2, { bomb_planted_tick: 100, bomb_defused_tick: 200, winner_team: 'CT' }),
      round(3, { winner_team: 'CT' }),                       // no plant
      round(0, { is_knife_round: true }),                    // excluded
    ];
    const events = [plant(1, 'A'), plant(2, 'B')];
    const got = buildRoundInsights(rounds, events);
    expect(got.map((r) => r.roundNumber)).toEqual([1, 2, 3]);
    expect(got[0]).toMatchObject({ site: 'A', planted: true, exploded: true, winner: 'T' });
    expect(got[1]).toMatchObject({ site: 'B', planted: true, defused: true });
    expect(got[2]).toMatchObject({ site: null, planted: false });
  });
});

describe('summarizeSites', () => {
  it('counts A/B/no-plant and post-plant T win rate', () => {
    const rounds = [
      round(1, { bomb_planted_tick: 1, bomb_exploded_tick: 2 }),   // A, not defused → T win
      round(2, { bomb_planted_tick: 1, bomb_defused_tick: 2 }),    // A, defused → CT
      round(3, { bomb_planted_tick: 1 }),                          // B, not defused → T win
      round(4),                                                    // no plant
    ];
    const events = [plant(1, 'A'), plant(2, 'A'), plant(3, 'B')];
    const s = summarizeSites(buildRoundInsights(rounds, events));
    expect(s).toMatchObject({ a: 2, b: 1, noPlant: 1, total: 4 });
    expect(s.postPlantTWinRate.a).toBeCloseTo(0.5);  // 1 of 2 A plants held
    expect(s.postPlantTWinRate.b).toBe(1);           // 1 of 1 B plant held
  });
});

describe('winRateByBuy', () => {
  it('tallies wins per buy class for a side', () => {
    // Round 1 is the pistol; rounds 2 & 3 are the two CT full buys.
    const rounds = [
      round(1, { ct_equip_value: 800, winner_team: 'CT' }),
      round(2, { ct_equip_value: 25000, winner_team: 'CT' }),
      round(3, { ct_equip_value: 25000, winner_team: 'T' }),
    ];
    const wr = winRateByBuy(buildRoundInsights(rounds, []), 'CT');
    expect(wr.full).toEqual({ n: 2, wins: 1 });
    expect(wr.pistol).toEqual({ n: 1, wins: 1 });
  });
});
