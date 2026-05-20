/**
 * Playback helpers: build tick→snapshot index for smooth scrubbing.
 *
 * The position array from the server is sparse (sampled every N ticks).
 * We build a lookup so the radar can efficiently find the nearest position
 * for any given tick within a round without scanning the full array.
 */

import type { PlayerPosition, TickSnapshot } from '../types';

/** Map from tick → snapshot (all players at that tick). */
export type TickIndex = Map<number, TickSnapshot>;

/**
 * Build a tick index from a flat array of PlayerPosition records.
 * Only positions for rounds in `allowedRounds` are indexed.
 */
export function buildTickIndex(
  positions: PlayerPosition[],
  allowedRounds?: number[],
): TickIndex {
  const allowed = allowedRounds ? new Set(allowedRounds) : null;
  const index: TickIndex = new Map();

  for (const pos of positions) {
    if (allowed && !allowed.has(pos.round_number)) continue;
    let snapshot = index.get(pos.tick);
    if (!snapshot) {
      snapshot = new Map();
      index.set(pos.tick, snapshot);
    }
    snapshot.set(pos.player_id, pos);
  }

  return index;
}

/**
 * Return the sorted list of unique ticks in the index.
 * Memoised outside this function by the caller.
 */
export function getSortedTicks(index: TickIndex): number[] {
  return Array.from(index.keys()).sort((a, b) => a - b);
}

/**
 * Find the index of the nearest tick at or before requestedTick using binary search.
 * Returns -1 if sortedTicks is empty.
 */
export function nearestTickIndex(
  requestedTick: number,
  sortedTicks: number[],
): number {
  if (!sortedTicks.length) return -1;
  if (requestedTick < sortedTicks[0]) return 0;

  let lo = 0;
  let hi = sortedTicks.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sortedTicks[mid] <= requestedTick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Find the nearest indexed tick at or before the requested tick.
 * Uses binary search on sortedTicks for O(log n) lookup.
 */
export function nearestTick(
  requestedTick: number,
  sortedTicks: number[],
): number | undefined {
  const idx = nearestTickIndex(requestedTick, sortedTicks);
  return idx === -1 ? undefined : sortedTicks[idx];
}

/**
 * Get a player position snapshot for a given absolute tick.
 * Returns undefined if no data is available.
 */
export function getSnapshotAtTick(
  tick: number,
  index: TickIndex,
  sortedTicks: number[],
): TickSnapshot | undefined {
  const nearest = nearestTick(tick, sortedTicks);
  if (nearest === undefined) return undefined;
  return index.get(nearest);
}

/**
 * Compute the ticks-per-second advancement for the playback timer
 * based on current speed multiplier and tick rate.
 */
export function ticksPerInterval(
  tickRate: number,
  speedMultiplier: number,
  intervalMs: number,
): number {
  return Math.round((tickRate * speedMultiplier * intervalMs) / 1000);
}

/** Format a tick count as mm:ss given tick rate. */
export function tickToTime(tick: number, startTick: number, tickRate: number): string {
  const seconds = (tick - startTick) / tickRate;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
