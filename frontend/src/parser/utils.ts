/**
 * Low-level parser helpers — TypeScript port of `backend/parser/_utils.py`.
 */

import type { Row } from './source';

/** Best-effort int conversion; treats null/NaN/invalid as `def`. Mirrors `_to_int`. */
export function toInt(value: unknown, def = 0): number {
  if (value === null || value === undefined) return def;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return def;
    return Math.trunc(value);
  }
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

/** Best-effort float conversion; treats null/NaN/invalid as `def`. Mirrors `_to_float`. */
export function toFloat(value: unknown, def = 0.0): number {
  if (value === null || value === undefined) return def;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : def;
}

/**
 * First finite float found among `keys`, else null. Mirrors `_coord`.
 * (Infinity/NaN are rejected, matching the Python guard.)
 */
export function coord(row: Row, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    const f = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

/** SteamID64 arrives as number|string|bigint; keep exact digits as a string. */
export function toSteamIdStr(value: unknown): string {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.trim() || '0';
  if (typeof value === 'number') {
    // A float64 SteamID64 has already lost precision; best effort.
    return Number.isFinite(value) ? BigInt(Math.trunc(value)).toString() : '0';
  }
  return String(value);
}

export interface RoundLike {
  round_number: number;
  start_tick: number;
  end_tick: number;
}

/**
 * O(log n) tick → round_number lookup backed by binary search.
 * Mirrors `_build_round_lookup`. Returns 0 when the tick is in no round.
 */
export function buildRoundLookup(rounds: RoundLike[]): (tick: number) => number {
  const sorted = [...rounds].sort((a, b) => a.start_tick - b.start_tick);
  const starts = sorted.map((r) => r.start_tick);
  const ends = sorted.map((r) => r.end_tick);
  const nums = sorted.map((r) => r.round_number);

  return (tick: number): number => {
    // bisect_right(starts, tick) - 1
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tick < starts[mid]) hi = mid;
      else lo = mid + 1;
    }
    const idx = lo - 1;
    if (idx >= 0 && tick <= ends[idx]) return nums[idx];
    return 0;
  };
}
