import { describe, it, expect } from 'vitest';
import { buildAwpRounds, buildTendencyBuckets, runLimited } from './tendencies';
import type { PlayerStateEvent, RoundInfo } from '../types';
import type { RoundSideMap } from './roundUtils';

function round(n: number, ct: number, t: number): RoundInfo {
  return {
    id: n, demo_id: 'd1', round_number: n,
    start_tick: 0, end_tick: 0, freeze_end_tick: 0,
    winner_team: 'CT', win_reason: '', ct_score: 0, t_score: 0,
    bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null,
    is_knife_round: false, ct_equip_value: ct, t_equip_value: t,
  };
}

function equip(rn: number, pid: number, weapon: string): PlayerStateEvent {
  return {
    id: rn, demo_id: 'd1', tick: 0, round_number: rn,
    player_id: pid, event_type: 'equip', hp: null, armor: null, weapon,
  };
}

const P1 = { key: '111', num: 111, dbId: 1, name: 'p1' };
const P2 = { key: '222', num: 222, dbId: 2, name: 'p2' };

describe('buildTendencyBuckets', () => {
  // Rounds: 1 = pistol (excluded), 2 = CT full, 3 = CT eco, 4 = CT half.
  const rounds = [round(1, 800, 800), round(2, 25000, 5000), round(3, 1500, 5000), round(4, 5000, 5000)];
  // P1 on CT every round; P2 on T every round.
  const sideMap: RoundSideMap = {
    d1: {
      '1': { '111': 'CT', '222': 'T' },
      '2': { '111': 'CT', '222': 'T' },
      '3': { '111': 'CT', '222': 'T' },
      '4': { '111': 'CT', '222': 'T' },
    },
  };

  it('splits a CT player\'s rounds into full and eco/half buckets', () => {
    const [b1, b2] = buildTendencyBuckets({
      side: 'CT', players: [P1, P2],
      roundsByDemo: [{ demoId: 'd1', rounds }],
      sideMap, awpRounds: new Map(),
    });
    expect(b1.full.map((r) => r.roundNumber)).toEqual([2]);
    expect(b1.ecoHalf.map((r) => r.roundNumber)).toEqual([3, 4]);
    // P2 never played CT → all buckets empty for the CT report.
    expect(b2.full).toEqual([]);
    expect(b2.ecoHalf).toEqual([]);
  });

  it('classifies the T report by the T side economy', () => {
    const [, b2] = buildTendencyBuckets({
      side: 'T', players: [P1, P2],
      roundsByDemo: [{ demoId: 'd1', rounds }],
      sideMap, awpRounds: new Map(),
    });
    // T equip is 5000 (half) in rounds 2-4; round 1 is the pistol.
    expect(b2.ecoHalf.map((r) => r.roundNumber)).toEqual([2, 3, 4]);
    expect(b2.full).toEqual([]);
  });

  it('fills the AWP bucket only for rounds on the requested side', () => {
    const awp = buildAwpRounds([
      { demoId: 'd1', events: [equip(2, 111, 'awp'), equip(3, 222, 'awp'), equip(4, 111, 'ak47')] },
    ]);
    const [b1, b2] = buildTendencyBuckets({
      side: 'CT', players: [P1, P2],
      roundsByDemo: [{ demoId: 'd1', rounds }],
      sideMap, awpRounds: awp,
    });
    expect(b1.awp.map((r) => r.roundNumber)).toEqual([2]);  // AWP + CT
    expect(b2.awp).toEqual([]);                             // AWP but on T
  });

  it('skips rounds without side data instead of guessing', () => {
    const partial: RoundSideMap = { d1: { '2': { '111': 'CT' } } };
    const [b1] = buildTendencyBuckets({
      side: 'CT', players: [P1],
      roundsByDemo: [{ demoId: 'd1', rounds }],
      sideMap: partial, awpRounds: new Map(),
    });
    expect(b1.full.map((r) => r.roundNumber)).toEqual([2]);
    expect(b1.ecoHalf).toEqual([]);
  });
});

describe('runLimited', () => {
  it('runs all jobs, keeps order, and nulls failures', async () => {
    let live = 0;
    let peak = 0;
    const job = (v: number, fail = false) => async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      if (fail) throw new Error('x');
      return v;
    };
    const done: number[] = [];
    const results = await runLimited(
      [job(1), job(2, true), job(3), job(4), job(5)],
      2,
      () => done.push(1),
    );
    expect(results).toEqual([1, null, 3, 4, 5]);
    expect(done.length).toBe(5);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
