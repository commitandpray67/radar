import { describe, expect, it } from 'vitest';
import {
  countByTier,
  highlightSeekTick,
  killLabel,
  runWithConcurrency,
  weaponLabel,
} from './highlights';
import type { Highlight, HighlightSearchResult } from '../types';

const hl = (kills: number): Highlight => ({
  round_number: 1,
  kills,
  round_kills: kills,
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
    expect(weaponLabel('taser')).toBe('taser');
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

describe('runWithConcurrency', () => {
  it('processes every item with at most `limit` in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      inFlight -= 1;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    await expect(runWithConcurrency([], 2, async () => {})).resolves.toBeUndefined();
  });
});
