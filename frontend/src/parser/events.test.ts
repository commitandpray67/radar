import { describe, it, expect } from 'vitest';
import {
  extractEvents, extractEconomy, extractPlayerStateEvents, inventoryItemToToken,
} from './events';
import type { DemoSource, Row, Columns } from './source';
import type { ParsedRound } from './types';

function makeSource(opts: {
  events?: Record<string, Row[]>;
  ticks?: (props: string[]) => Row[];
}): DemoSource {
  return {
    parseHeader: () => ({}),
    parseEvent: (name: string) => opts.events?.[name] ?? [],
    parseTicks: (props: string[]) => opts.ticks?.(props) ?? [],
    parseTicksColumnar: (): Columns => ({}),
    parseGrenades: (): Row[] => [],
  };
}

function round(n: number, start: number, end: number, freeze = start): ParsedRound {
  return {
    round_number: n, start_tick: start, end_tick: end, freeze_end_tick: freeze,
    winner_team: 'CT', win_reason: '', ct_score: 0, t_score: 0,
    bomb_planted_tick: null, bomb_defused_tick: null, bomb_exploded_tick: null,
    is_knife_round: false, ct_equip_value: 0, t_equip_value: 0,
  };
}

describe('inventoryItemToToken', () => {
  it('maps display names, passes through classnames, rejects unknowns', () => {
    expect(inventoryItemToToken('AK-47')).toBe('ak47');
    expect(inventoryItemToToken('M4A4')).toBe('m4a1');
    expect(inventoryItemToToken('Desert Eagle')).toBe('deagle');
    expect(inventoryItemToToken('weapon_awp')).toBe('weapon_awp');
    expect(inventoryItemToToken('Kevlar Vest')).toBeNull();
    expect(inventoryItemToToken('')).toBeNull();
  });
});

describe('extractEvents — kills', () => {
  it('emits sorted player_death events with attacker/victim/headshot', () => {
    const src = makeSource({
      events: {
        player_death: [
          { tick: 500, attacker_steamid: 111, user_steamid: 222, weapon: 'ak47', headshot: true },
          { tick: 300, attacker_steamid: 0, user_steamid: 333, weapon: 'world', headshot: false },
        ],
      },
    });
    const evs = extractEvents(src, [round(1, 0, 1000)]);
    expect(evs.map((e) => e.tick)).toEqual([300, 500]); // sorted
    expect(evs[1]).toMatchObject({ attacker_id: 111, victim_id: 222, weapon: 'ak47', headshot: 1 });
    expect(evs[0].attacker_id).toBeNull(); // steamid 0 → null
  });
});

describe('extractEvents — bomb site classification', () => {
  it('labels a plant A or B by planter position on de_dust2', () => {
    const src = makeSource({
      events: {
        bomb_planted: [{ tick: 600, user_X: 1240, user_Y: 2540 }],   // A centre
      },
    });
    const evs = extractEvents(src, [round(1, 0, 1000)], 'de_dust2');
    const plant = evs.find((e) => e.event_type === 'bomb_planted');
    expect(plant?.weapon).toBe('A');
  });

  it('returns null site when the map has no calibration', () => {
    const src = makeSource({ events: { bomb_planted: [{ tick: 600, user_X: 0, user_Y: 0 }] } });
    const evs = extractEvents(src, [round(1, 0, 1000)], 'de_unknownmap');
    expect(evs.find((e) => e.event_type === 'bomb_planted')?.weapon).toBeNull();
  });
});

describe('extractEconomy', () => {
  it('sums equip values per team at freeze_end', () => {
    const rounds = [round(1, 0, 1000, 100)];
    const src = makeSource({
      ticks: (props) => (props.includes('current_equip_value')
        ? [
            { tick: 100, team_num: 3, current_equip_value: 4000, steamid: 1 },
            { tick: 100, team_num: 3, current_equip_value: 4500, steamid: 2 },
            { tick: 100, team_num: 2, current_equip_value: 800, steamid: 3 },
          ]
        : []),
    });
    extractEconomy(src, rounds);
    expect(rounds[0].ct_equip_value).toBe(8500);
    expect(rounds[0].t_equip_value).toBe(800);
  });
});

describe('extractPlayerStateEvents — inventory sampling', () => {
  it('produces deduped equip events from the inventory prop', () => {
    const rounds = [round(1, 0, 1000, 0)];
    const src = makeSource({
      ticks: (props) => {
        if (props.includes('inventory')) {
          return [
            { tick: 0, steamid: 111, inventory: ['AK-47', 'Smoke Grenade'] },
            { tick: 320, steamid: 111, inventory: ['AK-47', 'Flashbang'] }, // AK dup, Flash new
          ];
        }
        return [];
      },
    });
    const evs = extractPlayerStateEvents(src, rounds).filter((e) => e.event_type === 'equip');
    const tokens = evs.map((e) => e.weapon).sort();
    expect(tokens).toEqual(['ak47', 'flashbang', 'smokegrenade']); // AK counted once
  });
});
