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

// Don't interpolate across gaps larger than this — a big gap usually means a
// round boundary / respawn, where interpolation would slide dots across the map.
const MAX_INTERP_GAP_TICKS = 128; // ~2 s at 64 tick

/** Shortest-arc linear interpolation between two angles in degrees. */
function lerpAngleDeg(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}

/**
 * Like getSnapshotAtTick, but linearly interpolates each player's position
 * (and view angle) between the nearest sampled ticks before and after `tick`,
 * giving smooth playback instead of dots stepping every sample interval.
 *
 * Interpolation is skipped — falling back to the "before" sample — when there
 * is no later sample, the gap is too large (round boundary), or a player's
 * life state / round differs between the two samples.
 */
export function getInterpolatedSnapshot(
  tick: number,
  index: TickIndex,
  sortedTicks: number[],
): TickSnapshot | undefined {
  if (!sortedTicks.length) return undefined;
  const i = nearestTickIndex(tick, sortedTicks);
  if (i === -1) return undefined;

  const beforeTick = sortedTicks[i];
  const beforeSnap = index.get(beforeTick);
  if (!beforeSnap) return undefined;

  const afterTick = sortedTicks[i + 1];
  if (beforeTick === tick || afterTick === undefined) return beforeSnap;

  const gap = afterTick - beforeTick;
  if (gap <= 0 || gap > MAX_INTERP_GAP_TICKS || tick <= beforeTick) return beforeSnap;
  const afterSnap = index.get(afterTick);
  if (!afterSnap) return beforeSnap;

  const frac = (tick - beforeTick) / gap;
  const out: TickSnapshot = new Map();
  for (const [pid, b] of beforeSnap.entries()) {
    const a = afterSnap.get(pid);
    // Only interpolate when the player exists in both samples with the same
    // life state and round — never slide a corpse or cross a respawn.
    if (!a || a.is_alive !== b.is_alive || a.round_number !== b.round_number) {
      out.set(pid, b);
      continue;
    }
    out.set(pid, {
      ...b,
      tick,
      x: b.x + (a.x - b.x) * frac,
      y: b.y + (a.y - b.y) * frac,
      z: b.z + (a.z - b.z) * frac,
      yaw:
        b.yaw != null && a.yaw != null ? lerpAngleDeg(b.yaw, a.yaw, frac) : b.yaw,
    });
  }
  return out;
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
