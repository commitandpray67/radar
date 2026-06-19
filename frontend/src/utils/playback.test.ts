import { describe, it, expect } from 'vitest';
import {
  buildTickIndex,
  getSortedTicks,
  nearestTickIndex,
  ticksPerInterval,
  tickToTime,
  getInterpolatedSnapshot,
} from './playback';
import type { PlayerPosition } from '../types';

function pos(tick: number, x: number, opts: Partial<PlayerPosition> = {}): PlayerPosition {
  return {
    tick,
    round_number: 1,
    player_id: 1,
    x,
    y: 0,
    z: 0,
    team_num: 3,
    is_alive: 1,
    yaw: 0,
    ...opts,
  };
}

describe('nearestTickIndex', () => {
  const ticks = [0, 10, 20, 30];
  it('finds the nearest tick at or before the request', () => {
    expect(nearestTickIndex(0, ticks)).toBe(0);
    expect(nearestTickIndex(5, ticks)).toBe(0);
    expect(nearestTickIndex(10, ticks)).toBe(1);
    expect(nearestTickIndex(25, ticks)).toBe(2);
    expect(nearestTickIndex(1000, ticks)).toBe(3);
  });
  it('clamps below the first tick and handles empty input', () => {
    expect(nearestTickIndex(-5, ticks)).toBe(0);
    expect(nearestTickIndex(5, [])).toBe(-1);
  });
});

describe('ticksPerInterval', () => {
  it('scales with tick rate, speed, and interval', () => {
    expect(ticksPerInterval(64, 1, 1000)).toBe(64);
    expect(ticksPerInterval(64, 2, 500)).toBe(64);
    expect(ticksPerInterval(128, 1, 1000)).toBe(128);
  });
});

describe('tickToTime', () => {
  it('formats elapsed ticks as mm:ss', () => {
    expect(tickToTime(0, 0, 64)).toBe('0:00');
    expect(tickToTime(64 * 65, 0, 64)).toBe('1:05');
    expect(tickToTime(64 * 9, 0, 64)).toBe('0:09');
  });
});

describe('buildTickIndex / getSortedTicks', () => {
  const positions: PlayerPosition[] = [
    pos(20, 5),
    pos(0, 1),
    pos(10, 3, { player_id: 2 }),
    pos(10, 9, { player_id: 1 }),
    pos(5, 0, { round_number: 2 }),
  ];
  it('indexes positions by tick and player, filtered by allowed rounds', () => {
    const idx = buildTickIndex(positions, [1]);
    expect(getSortedTicks(idx)).toEqual([0, 10, 20]); // round-2 tick 5 excluded
    expect(idx.get(10)?.size).toBe(2); // two players at tick 10
    expect(idx.get(10)?.get(1)?.x).toBe(9);
  });
  it('indexes all rounds when no filter is given', () => {
    const idx = buildTickIndex(positions);
    expect(getSortedTicks(idx)).toEqual([0, 5, 10, 20]);
  });
});

describe('getInterpolatedSnapshot', () => {
  function indexFrom(positions: PlayerPosition[]) {
    const index = buildTickIndex(positions);
    return { index, ticks: getSortedTicks(index) };
  }

  it('linearly interpolates position between samples', () => {
    const { index, ticks } = indexFrom([pos(0, 0), pos(10, 100)]);
    const snap = getInterpolatedSnapshot(5, index, ticks);
    expect(snap?.get(1)?.x).toBeCloseTo(50);
    expect(snap?.get(1)?.tick).toBe(5);
  });

  it('interpolates yaw along the shortest arc', () => {
    const { index, ticks } = indexFrom([pos(0, 0, { yaw: 0 }), pos(10, 0, { yaw: 90 })]);
    const snap = getInterpolatedSnapshot(5, index, ticks);
    expect(snap?.get(1)?.yaw).toBeCloseTo(45);
  });

  it('returns the exact sample on a direct hit', () => {
    const { index, ticks } = indexFrom([pos(0, 0), pos(10, 100)]);
    expect(getInterpolatedSnapshot(0, index, ticks)?.get(1)?.x).toBe(0);
  });

  it('does not interpolate across a large gap (round boundary)', () => {
    const { index, ticks } = indexFrom([pos(0, 0), pos(500, 100)]);
    // Gap (500) exceeds the cap, so we fall back to the before-sample value.
    expect(getInterpolatedSnapshot(250, index, ticks)?.get(1)?.x).toBe(0);
  });

  it('does not interpolate a player whose life state changed', () => {
    const { index, ticks } = indexFrom([
      pos(0, 0, { is_alive: 1 }),
      pos(10, 100, { is_alive: 0 }),
    ]);
    // Don't slide a corpse — fall back to the before sample.
    expect(getInterpolatedSnapshot(5, index, ticks)?.get(1)?.x).toBe(0);
  });
});
