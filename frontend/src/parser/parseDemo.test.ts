import { describe, it, expect } from 'vitest';
import { parseDemo } from './parseDemo';
import type { DemoSource, Row, Columns } from './source';

/**
 * A tiny synthetic demo: 2 rounds on de_dust2, 2 players (one CT, one T in
 * round 1), a kill, a bomb plant, a smoke, economy + inventory. Exercises the
 * whole pipeline end-to-end against the fake source.
 */
const R = 2000;

function makeSource(): DemoSource {
  const events: Record<string, Row[]> = {
    round_start: [{ tick: 0 }, { tick: R }],
    round_end: [
      { tick: R - 10, winner: 'CT', reason: '9' },
      { tick: 2 * R, winner: 'T', reason: '9' },
    ],
    round_freeze_end: [{ tick: 100 }, { tick: R + 100 }],
    player_death: [{ tick: 500, attacker_steamid: 111, user_steamid: 222, weapon: 'ak47', headshot: true }],
    bomb_planted: [{ tick: 600, user_X: 1240, user_Y: 2540 }], // dust2 A
    weapon_fire: [{ tick: 300, weapon: 'weapon_smokegrenade', user_steamid: 111 }],
    smokegrenade_detonate: [{ tick: 340, x: 200, y: 100, z: 0, user_steamid: 111 }],
    player_hurt: [{ tick: 480, user_steamid: 222, hp: 40, armor: 90, weapon: 'ak47' }],
  };

  // parse_grenades trajectory for the smoke
  const traj: Row[] = [];
  for (let i = 0; i < 8; i++) traj.push({ grenade_type: 'CSmokeGrenadeProjectile', tick: 300 + i * 5, X: i * 25, Y: i * 12, Z: 0, thrower_steamid: 111 });

  return {
    parseHeader: () => ({ map_name: 'de_dust2', playback_ticks: 4000, playback_time: 62.5 }),
    parseEvent: (name: string) => events[name] ?? [],
    parseTicks: (props: string[]) => {
      if (props.includes('name')) {
        return [
          { tick: 100, name: 'Alice', team_num: 3, steamid: 111 },
          { tick: 100, name: 'Bob', team_num: 2, steamid: 222 },
        ];
      }
      if (props.includes('current_equip_value')) {
        return [
          { tick: 100, team_num: 3, current_equip_value: 4000, steamid: 111 },
          { tick: 100, team_num: 2, current_equip_value: 800, steamid: 222 },
        ];
      }
      if (props.includes('inventory')) {
        return [{ tick: 100, steamid: 111, inventory: ['AK-47', 'Smoke Grenade'] }];
      }
      return [];
    },
    parseTicksColumnar: (props: string[], ticks?: number[]): Columns => {
      if (!props.includes('X') || !ticks) return {};
      // One position per sampled tick for player 111 in each round.
      const rows: Row[] = ticks.map((t) => ({
        tick: t, steamid: 111,
        X: 100 + t * 0.1, Y: 200, Z: 5,
        team_num: t < R ? 3 : 2, // CT in round 1, swapped in round 2
        is_alive: true, yaw: 45,
      }));
      const cols: Columns = {};
      const keys = new Set<string>();
      rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
      keys.forEach((k) => { cols[k] = rows.map((r) => r[k]); });
      return cols;
    },
    parseGrenades: () => traj,
  };
}

describe('parseDemo — full pipeline', () => {
  const demo = parseDemo(makeSource());

  it('derives match info and tick rate from the header', () => {
    expect(demo.matchInfo.map_name).toBe('de_dust2');
    expect(demo.matchInfo.total_ticks).toBe(4000);
    expect(demo.matchInfo.tick_rate).toBe(64); // 4000 / 62.5
  });

  it('produces rounds with winners and economy', () => {
    expect(demo.rounds).toHaveLength(2);
    expect(demo.rounds[0]).toMatchObject({ winner_team: 'CT', ct_equip_value: 4000, t_equip_value: 800 });
  });

  it('produces the kill and the A-site plant', () => {
    const kill = demo.events.find((e) => e.event_type === 'player_death');
    expect(kill).toMatchObject({ attacker_id: 111, victim_id: 222, headshot: 1 });
    const plant = demo.events.find((e) => e.event_type === 'bomb_planted');
    expect(plant?.weapon).toBe('A');
  });

  it('produces a smoke grenade with a trajectory', () => {
    expect(demo.grenades).toHaveLength(1);
    expect(demo.grenades[0]).toMatchObject({ grenade_type: 'smoke', throw_tick: 300, detonate_tick: 340 });
    expect(demo.grenades[0].trajectory!.length).toBeGreaterThanOrEqual(2);
  });

  it('samples positions and player state (hurt + inventory equip)', () => {
    expect(demo.positions.length).toBeGreaterThan(0);
    expect(demo.playerStateEvents.some((e) => e.event_type === 'hurt')).toBe(true);
    expect(demo.playerStateEvents.some((e) => e.event_type === 'equip' && e.weapon === 'ak47')).toBe(true);
  });

  it('overrides initial_team from first-round positions (player 111 = CT)', () => {
    const alice = demo.players.find((p) => p.player_id === 111);
    expect(alice?.initial_team).toBe('CT');
    expect(alice?.player_id_str).toBe('111');
  });
});
