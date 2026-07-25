import { describe, it, expect } from 'vitest';
import { buildTracks, extractGrenades } from './grenades';
import type { DemoSource, Row, Columns } from './source';
import type { ParsedRound } from './types';

interface Pt { tick: number; x: number; y: number; z: number; thrower_id: number; }
const pt = (tick: number, x: number, y: number, thrower = 0): Pt => ({ tick, x, y, z: 0, thrower_id: thrower });

function maxJump(track: { x: number; y: number }[]): number {
  let m = 0;
  for (let i = 1; i < track.length; i++) {
    m = Math.max(m, Math.hypot(track[i].x - track[i - 1].x, track[i].y - track[i - 1].y));
  }
  return m;
}

describe('buildTracks — webbing regression', () => {
  it('keeps a resting grenade and a passing grenade in separate tracks', () => {
    // Resting smoke at (0,0) emitting every tick + a smoke flying past nearby.
    const rows: Pt[] = [];
    for (let i = 0; i < 30; i++) {
      const tick = 1000 + i * 2;
      rows.push(pt(tick, 0, 0));
      rows.push(pt(tick, 100 + i * 15, 50));
    }
    rows.sort((a, b) => a.tick - b.tick);
    const tracks = buildTracks(rows);
    expect(tracks).toHaveLength(2);
    // No track alternates between the two projectiles (that = huge jumps).
    for (const t of tracks) expect(maxJump(t)).toBeLessThan(60);
  });

  it('collapses same-tick duplicate rows into one observation', () => {
    const rows: Pt[] = [];
    for (let i = 0; i < 10; i++) {
      const tick = 500 + i;
      rows.push(pt(tick, i * 10, 0));
      rows.push(pt(tick, i * 10 + 0.5, 0)); // near-duplicate
    }
    const tracks = buildTracks(rows);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toHaveLength(10);
  });

  it('never mixes two known throwers', () => {
    const rows: Pt[] = [];
    for (let i = 0; i < 20; i++) {
      const tick = 100 + i;
      rows.push(pt(tick, i * 20, 0, 111));       // left → right
      rows.push(pt(tick, 380 - i * 20, 40, 222)); // right → left
    }
    rows.sort((a, b) => a.tick - b.tick);
    const tracks = buildTracks(rows);
    expect(tracks).toHaveLength(2);
    for (const t of tracks) {
      expect(new Set(t.map((p) => p.thrower_id)).size).toBe(1);
    }
  });

  it('leaves a single grenade untouched', () => {
    const rows = Array.from({ length: 40 }, (_, i) => pt(100 + i, i * 12, i * 5));
    const tracks = buildTracks(rows);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toHaveLength(40);
  });
});

function round(n: number, start: number, end: number): ParsedRound {
  return {
    round_number: n, start_tick: start, end_tick: end, freeze_end_tick: start,
    winner_team: 'CT', win_reason: '', ct_score: 0, t_score: 0,
    bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null,
    is_knife_round: false, ct_equip_value: 0, t_equip_value: 0,
  };
}

describe('extractGrenades — throw→detonation matching', () => {
  it('matches a smoke throw to its detonation and attaches a trajectory', () => {
    const traj: Row[] = [];
    for (let i = 0; i < 10; i++) traj.push({ grenade_type: 'CSmokeGrenadeProjectile', tick: 100 + i * 4, X: i * 30, Y: i * 10, Z: 0, thrower_steamid: 111 });
    const src: DemoSource = {
      parseHeader: () => ({}),
      parseEvent: (name: string) => {
        if (name === 'weapon_fire') return [{ tick: 100, weapon: 'weapon_smokegrenade', user_steamid: 111 }];
        if (name === 'smokegrenade_detonate') return [{ tick: 140, x: 270, y: 90, z: 0, user_steamid: 111 }];
        return [];
      },
      parseTicks: (): Row[] => [],
      parseTicksColumnar: (): Columns => ({}),
      parseGrenades: () => traj,
    };
    const grenades = extractGrenades(src, [round(1, 0, 1000)], 64);
    expect(grenades).toHaveLength(1);
    expect(grenades[0]).toMatchObject({ grenade_type: 'smoke', throw_tick: 100, detonate_tick: 140, thrower_id: 111 });
    expect(grenades[0].trajectory!.length).toBeGreaterThanOrEqual(2);
  });

  it('synthesizes grenades from trajectories when there are no throw events', () => {
    const traj: Row[] = [];
    for (let i = 0; i < 8; i++) traj.push({ grenade_type: 'CHEGrenadeProjectile', tick: 200 + i * 4, X: i * 25, Y: 5, Z: 0, thrower_steamid: 222 });
    const src: DemoSource = {
      parseHeader: () => ({}),
      parseEvent: (): Row[] => [], // no weapon_fire, no detonations
      parseTicks: (): Row[] => [],
      parseTicksColumnar: (): Columns => ({}),
      parseGrenades: () => traj,
    };
    const grenades = extractGrenades(src, [round(1, 0, 1000)], 64);
    expect(grenades).toHaveLength(1);
    expect(grenades[0]).toMatchObject({ grenade_type: 'he', thrower_id: 222 });
    expect(grenades[0].trajectory!.length).toBeGreaterThanOrEqual(2);
  });
});
