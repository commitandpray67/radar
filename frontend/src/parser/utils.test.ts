import { describe, it, expect } from 'vitest';
import { toInt, toFloat, coord, buildRoundLookup, toSteamIdStr } from './utils';

describe('toInt / toFloat', () => {
  it('handles numbers, strings, null and NaN', () => {
    expect(toInt(3.9)).toBe(3);
    expect(toInt('42')).toBe(42);
    expect(toInt(null, 7)).toBe(7);
    expect(toInt(NaN, 5)).toBe(5);
    expect(toInt('nope', 1)).toBe(1);
    expect(toFloat('1.5')).toBe(1.5);
    expect(toFloat(null, 0.0)).toBe(0);
    expect(toFloat(Infinity, 2)).toBe(2);
  });
});

describe('coord', () => {
  it('returns the first finite value among keys, else null', () => {
    expect(coord({ X: 1.2, x: 9 }, 'X', 'x')).toBe(1.2);
    expect(coord({ x: 3 }, 'X', 'x')).toBe(3);
    expect(coord({ X: NaN, x: Infinity }, 'X', 'x')).toBeNull();
    expect(coord({}, 'X')).toBeNull();
  });
});

describe('toSteamIdStr', () => {
  it('preserves exact digits for string/bigint inputs', () => {
    expect(toSteamIdStr('76561198000000001')).toBe('76561198000000001');
    expect(toSteamIdStr(76561198000000001n)).toBe('76561198000000001');
    expect(toSteamIdStr(null)).toBe('0');
    expect(toSteamIdStr('  ')).toBe('0');
  });
});

describe('buildRoundLookup', () => {
  const rounds = [
    { round_number: 1, start_tick: 100, end_tick: 200 },
    { round_number: 2, start_tick: 210, end_tick: 400 },
    { round_number: 3, start_tick: 420, end_tick: 600 },
  ];
  const lookup = buildRoundLookup(rounds);

  it('maps ticks to their round, 0 for gaps/out-of-range', () => {
    expect(lookup(100)).toBe(1);
    expect(lookup(200)).toBe(1);
    expect(lookup(205)).toBe(0);   // between rounds
    expect(lookup(210)).toBe(2);
    expect(lookup(600)).toBe(3);
    expect(lookup(50)).toBe(0);    // before first
    expect(lookup(9999)).toBe(0);  // after last
  });

  it('is order-independent (sorts internally)', () => {
    const shuffled = buildRoundLookup([rounds[2], rounds[0], rounds[1]]);
    expect(shuffled(300)).toBe(2);
    expect(shuffled(500)).toBe(3);
  });
});
