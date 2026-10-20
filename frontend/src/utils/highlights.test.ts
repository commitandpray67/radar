import { describe, expect, it } from 'vitest';
import {
  countByTier,
  highlightSeekTick,
  killBreakdown,
  weaponsText,
  apiErrorMessage,
  killLabel,
  searchInChunks,
  weaponLabel,
} from './highlights';
import type { Highlight, HighlightSearchResult } from '../types';

const hl = (kills: number): Highlight => ({
  round_number: 1,
  display_round: 1,
  player_id: '1',
  player_name: 'Q',
  kills,
  weapon_kills: kills,
  side: 'CT',
  round_won: true,
  first_kill_tick: 0,
  last_kill_tick: 0,
  duration_s: 0,
  kill_list: [],
});

describe('highlight labels', () => {
  it('labels kill tiers', () => {
    expect(killLabel(3)).toBe('3K');
    expect(killLabel(4)).toBe('4K');
    expect(killLabel(5)).toBe('ACE');
    expect(killLabel(6)).toBe('ACE');
  });

  it('labels weapons, falling back to the raw token', () => {
    expect(weaponLabel('deagle')).toBe('Desert Eagle');
    expect(weaponLabel('m4a1')).toBe('M4A4');
    expect(weaponLabel('taser')).toBe('Zeus x27');
    expect(weaponLabel('world')).toBe('world');
  });
});

describe('weapon summaries', () => {
  it('describes the weapon filter', () => {
    expect(weaponsText([])).toBe('any weapon');
    expect(weaponsText(['deagle', 'awp'])).toBe('Desert Eagle / AWP');
  });

  it('breaks a highlight down by weapon, most-used first', () => {
    const kill = (weapon: string) => ({
      tick: 0, victim_id: '1', victim_name: '', weapon, headshot: false, matches: weapon === 'deagle',
    });
    const h = { ...hl(3), kill_list: [kill('ak47'), kill('deagle'), kill('deagle')] };
    expect(killBreakdown(h)).toBe('2 Desert Eagle + 1 AK-47');
  });
});

describe('highlightSeekTick', () => {
  it('seeks a few seconds before the first kill', () => {
    expect(highlightSeekTick(1000, 5000, 64, 4)).toBe(5000 - 256);
  });

  it('never seeks before the round start', () => {
    expect(highlightSeekTick(4900, 5000, 64, 4)).toBe(4900);
  });
});

describe('countByTier', () => {
  it('counts highlights across demos', () => {
    const result: HighlightSearchResult = {
      player: 'Qiyarah',
      weapons: ['deagle'],
      min_kills: 3,
      total: 4,
      demos: [
        { demo_id: 'a', highlights: [hl(3), hl(5)] },
        { demo_id: 'b', highlights: [hl(3), hl(4)] },
      ],
    };
    expect(countByTier(result)).toEqual({ '3K': 2, '4K': 1, ACE: 1 });
  });
});

describe('searchInChunks', () => {
  const payload = { demo_ids: ['a', 'b', 'c', 'd', 'e'], player: 'Q', weapons: [], min_kills: 3, min_weapon_kills: 0 };
  const fake = async (p: typeof payload): Promise<HighlightSearchResult> => ({
    player: p.player, weapons: [], min_kills: 3, min_weapon_kills: 0,
    total: p.demo_ids.length,
    demos: p.demo_ids.map((id) => ({ demo_id: id, highlights: [] })),
  });

  it('splits large demo sets and merges the results in order', async () => {
    const calls: string[][] = [];
    const res = await searchInChunks(payload, async (p) => { calls.push(p.demo_ids); return fake(p); }, 2);
    expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(res.total).toBe(5);
    expect(res.demos.map((d) => d.demo_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('makes a single request when under the cap', async () => {
    let n = 0;
    await searchInChunks(payload, async (p) => { n += 1; return fake(p); });
    expect(n).toBe(1);
  });
});

describe('apiErrorMessage', () => {
  it('formats FastAPI 422 validation details', () => {
    const err = { response: { data: { detail: [{ loc: ['body', 'demo_ids'], msg: 'too long' }] } } };
    expect(apiErrorMessage(err, 'x')).toBe('demo_ids: too long');
  });

  it('passes string details through and falls back to the error message', () => {
    expect(apiErrorMessage({ response: { data: { detail: 'nope' } } }, 'x')).toBe('nope');
    expect(apiErrorMessage(new Error('boom'), 'x')).toBe('boom');
    expect(apiErrorMessage({}, 'fallback')).toBe('fallback');
  });
});
