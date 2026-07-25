/**
 * Grenade extraction — TypeScript port of `backend/parser/_grenades.py`.
 *
 * Matches weapon_fire throws to detonation events, attaches trajectories from
 * parse_grenades() entity rows, and — when a demo has no throw events (POV
 * recordings) — synthesizes grenades directly from the trajectory tracks.
 *
 * Includes the v29 `buildTracks` fix for the trajectory "webbing" artifact.
 */

import type { DemoSource } from './source';
import type { GrenadeType } from '../types';
import type { ParsedGrenade, ParsedRound } from './types';
import { buildRoundLookup, coord, toInt } from './utils';

// weapon_fire weapon name → normalised grenade type
const GRENADE_WEAPONS: Record<string, GrenadeType> = {
  hegrenade: 'he', weapon_hegrenade: 'he',
  flashbang: 'flash', weapon_flashbang: 'flash',
  smokegrenade: 'smoke', weapon_smokegrenade: 'smoke',
  molotov: 'molotov', weapon_molotov: 'molotov',
  incgrenade: 'incendiary', weapon_incgrenade: 'incendiary',
  decoy: 'decoy', weapon_decoy: 'decoy',
};

// detonation event name → normalised type
const DETONATE_EVENTS: Record<string, GrenadeType> = {
  hegrenade_detonate: 'he',
  flashbang_detonate: 'flash',
  smokegrenade_detonate: 'smoke',
  molotov_detonate: 'molotov',
  inferno_startburn: 'molotov', // covers molotov & incendiary
};

// parse_grenades() entity class name → type (keys pre-normalised: no space/underscore)
const TRAJ_TYPE_MAP: Record<string, GrenadeType> = {
  hegrenade: 'he', chegrenadeprojectile: 'he',
  flashbang: 'flash', cflashbangprojectile: 'flash',
  smokegrenade: 'smoke', csmokegrenadeprojectile: 'smoke',
  molotov: 'molotov', cmolotovprojectile: 'molotov', molotovgrenade: 'molotov',
  incendiarygrenade: 'incendiary', cincendiaryprojectile: 'incendiary', incendiary: 'incendiary',
  decoygrenade: 'decoy', cdecoyprojectile: 'decoy', decoy: 'decoy', cdecoyprojector: 'decoy',
};

const TRAJ_SUBSTR_FALLBACK: Array<[string, GrenadeType]> = [
  ['hegrenade', 'he'], ['flashbang', 'flash'], ['smokegrenade', 'smoke'],
  ['smoke', 'smoke'], ['molotov', 'molotov'], ['incendiary', 'incendiary'], ['decoy', 'decoy'],
];

// Approx effect duration in ticks at 64-tick (scaled by tick_rate elsewhere)
const EFFECT_TICKS: Record<string, number> = {
  he: 64, flash: 48, smoke: 1152, molotov: 448, incendiary: 448, decoy: 256,
};

function mapGrenadeType(raw: string): GrenadeType | null {
  const key = raw.toLowerCase().replace(/ /g, '').replace(/_/g, '');
  if (key in TRAJ_TYPE_MAP) return TRAJ_TYPE_MAP[key];
  for (const [sub, g] of TRAJ_SUBSTR_FALLBACK) {
    if (key.includes(sub)) return g;
  }
  return null;
}

interface RawTraj { gtype: GrenadeType; tick: number; rn: number; x: number; y: number; z: number; thrower_id: number; }
interface TrackPt { tick: number; x: number; y: number; z: number; thrower_id: number; }
interface TrajPoint { tick: number; x: number; y: number; z: number; }

interface ActiveTrack { pts: TrackPt[]; last_x: number; last_y: number; last_tick: number; thrower_id: number; }

/**
 * Tick-batched nearest-neighbour multi-object tracker (v29).
 *
 * Per-tick exclusive assignment prevents the "webbing" artifact where a flying
 * grenade's rows were appended to a resting grenade's track. See the Python
 * docstring for the three constraints (dup-collapse, one-track-per-obs,
 * thrower gating).
 */
export function buildTracks(bucketSorted: TrackPt[]): TrackPt[][] {
  const MATCH_DIST_SQ = 500 ** 2;
  const TRACK_GAP = 16;
  const DUP_DIST_SQ = 4.0 ** 2;

  let active: ActiveTrack[] = [];
  const finished: TrackPt[][] = [];

  let i = 0;
  const n = bucketSorted.length;
  while (i < n) {
    const tick = bucketSorted[i].tick;
    const tickRows: TrackPt[] = [];
    while (i < n && bucketSorted[i].tick === tick) {
      tickRows.push(bucketSorted[i]);
      i++;
    }

    // Retire stale tracks
    const live: ActiveTrack[] = [];
    for (const t of active) {
      if (tick - t.last_tick <= TRACK_GAP) live.push(t);
      else finished.push(t.pts);
    }
    active = live;

    // 1. Collapse near-duplicate observations of the same projectile.
    const obs: TrackPt[] = [];
    for (const row of tickRows) {
      const dup = obs.some((o) => (row.x - o.x) ** 2 + (row.y - o.y) ** 2 <= DUP_DIST_SQ);
      if (!dup) obs.push(row);
    }

    // 2. Greedy min-distance assignment; each obs/track used once per tick.
    const pairs: Array<[number, number, number]> = []; // [dsq, obsIdx, trkIdx]
    for (let oi = 0; oi < obs.length; oi++) {
      const row = obs[oi];
      for (let ti = 0; ti < active.length; ti++) {
        const t = active[ti];
        // 3. A known thrower never extends another thrower's track.
        if (row.thrower_id && t.thrower_id && row.thrower_id !== t.thrower_id) continue;
        const dsq = (row.x - t.last_x) ** 2 + (row.y - t.last_y) ** 2;
        if (dsq < MATCH_DIST_SQ) pairs.push([dsq, oi, ti]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);

    const usedObs = new Set<number>();
    const usedTrk = new Set<number>();
    for (const [, oi, ti] of pairs) {
      if (usedObs.has(oi) || usedTrk.has(ti)) continue;
      usedObs.add(oi);
      usedTrk.add(ti);
      const t = active[ti];
      const row = obs[oi];
      t.pts.push(row);
      t.last_x = row.x;
      t.last_y = row.y;
      t.last_tick = tick;
      if (!t.thrower_id) t.thrower_id = row.thrower_id;
    }

    // Unmatched observations start new tracks.
    for (let oi = 0; oi < obs.length; oi++) {
      if (!usedObs.has(oi)) {
        const row = obs[oi];
        active.push({ pts: [row], last_x: row.x, last_y: row.y, last_tick: tick, thrower_id: row.thrower_id });
      }
    }
  }

  for (const t of active) finished.push(t.pts);
  return finished.filter((pts) => pts.length >= 2);
}

const MAX_TRAJ_WP = 48;

function sampleTrack(track: TrackPt[]): TrajPoint[] {
  const step = Math.max(1, Math.trunc(track.length / MAX_TRAJ_WP));
  const sampled: TrackPt[] = [];
  for (let k = 0; k < track.length; k += step) sampled.push(track[k]);
  if (sampled[sampled.length - 1] !== track[track.length - 1]) sampled.push(track[track.length - 1]);
  return sampled.map((r) => ({ tick: r.tick, x: r.x, y: r.y, z: r.z }));
}

interface ThrowRec { tick: number; round_number: number; thrower_id: number; grenade_type: GrenadeType; }
interface DetRec { tick: number; round_number: number; grenade_type: GrenadeType; x: number; y: number; z: number; thrower_id: number; }

export function extractGrenades(
  source: DemoSource,
  rounds: ParsedRound[],
  tickRate = 64.0,
): ParsedGrenade[] {
  const rn = buildRoundLookup(rounds);

  // ---- Throws (weapon_fire filtered to grenade weapons) ------------------
  const throws: ThrowRec[] = [];
  try {
    for (const row of source.parseEvent('weapon_fire', ['tick', 'weapon', 'user_steamid'])) {
      const weapon = String(row.weapon ?? '').toLowerCase();
      const gtype = GRENADE_WEAPONS[weapon];
      if (!gtype) continue;
      const tick = toInt(row.tick ?? 0);
      const round = rn(tick);
      if (round === 0) continue;
      throws.push({ tick, round_number: round, thrower_id: toInt(row.user_steamid ?? 0), grenade_type: gtype });
    }
  } catch {
    /* weapon_fire unavailable */
  }

  // ---- Detonations -------------------------------------------------------
  const detonations: DetRec[] = [];
  for (const [name, gtype] of Object.entries(DETONATE_EVENTS)) {
    try {
      for (const row of source.parseEvent(name, ['tick', 'x', 'y', 'z', 'user_steamid'])) {
        const tick = toInt(row.tick ?? 0);
        const round = rn(tick);
        if (round === 0) continue;
        const x = coord(row, 'x', 'X');
        const y = coord(row, 'y', 'Y');
        if (x === null || y === null) continue;
        detonations.push({ tick, round_number: round, grenade_type: gtype, x, y, z: coord(row, 'z', 'Z') ?? 0.0, thrower_id: toInt(row.user_steamid ?? 0) });
      }
    } catch {
      /* detonation event unavailable */
    }
  }

  // ---- Expire events (smoke / fire end) per round ------------------------
  const expireList = new Map<number, Array<{ tick: number; x: number; y: number }>>();
  for (const name of ['smokegrenade_expired', 'inferno_expire']) {
    try {
      for (const row of source.parseEvent(name, ['tick', 'x', 'y'])) {
        const tick = toInt(row.tick ?? 0);
        const round = rn(tick);
        if (round === 0) continue;
        const x = coord(row, 'x', 'X');
        const y = coord(row, 'y', 'Y');
        if (x === null || y === null) continue;
        const list = expireList.get(round) ?? [];
        list.push({ tick, x, y });
        expireList.set(round, list);
      }
    } catch {
      /* expire event unavailable */
    }
  }

  // ---- Per-tick trajectory rows from parse_grenades() --------------------
  const rawTraj: RawTraj[] = [];
  try {
    for (const row of source.parseGrenades()) {
      const gtype = mapGrenadeType(String(row.grenade_type ?? ''));
      if (gtype === null) continue;
      const tick = toInt(row.tick ?? 0);
      const round = rn(tick);
      if (round === 0) continue;
      const x = coord(row, 'X', 'x');
      const y = coord(row, 'Y', 'y');
      if (x === null || y === null) continue;
      const z = coord(row, 'Z', 'z') ?? 0.0;
      if (z < -4096) continue; // parked below map while in inventory
      rawTraj.push({ gtype, tick, rn: round, x, y, z, thrower_id: toInt(row.thrower_steamid ?? 0) });
    }
  } catch {
    /* parse_grenades unavailable */
  }

  // ---- Match throws to detonations ---------------------------------------
  const tickScale = tickRate && tickRate > 0 ? tickRate / 64.0 : 1.0;
  const MAX_FLIGHT_TICKS = Math.round(448 * tickScale);
  const usedDet = new Set<number>();
  let grenades: ParsedGrenade[] = [];

  const detsByRound = new Map<number, Array<[number, DetRec]>>();
  detonations.forEach((det, idx) => {
    const list = detsByRound.get(det.round_number) ?? [];
    list.push([idx, det]);
    detsByRound.set(det.round_number, list);
  });

  for (const thr of [...throws].sort((a, b) => a.tick - b.tick)) {
    let bestIdx: number | null = null;
    let bestDiff = MAX_FLIGHT_TICKS + 1;

    for (const [idx, det] of detsByRound.get(thr.round_number) ?? []) {
      if (usedDet.has(idx)) continue;
      const nt = thr.grenade_type;
      const dt = det.grenade_type;
      if (nt !== dt && !((nt === 'molotov' || nt === 'incendiary') && dt === 'molotov')) continue;
      const diff = det.tick - thr.tick;
      if (diff < 0 || diff > MAX_FLIGHT_TICKS) continue;
      if (det.thrower_id && thr.thrower_id && det.thrower_id !== thr.thrower_id) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = idx;
      }
    }

    if (bestIdx === null) {
      grenades.push({ round_number: thr.round_number, thrower_id: thr.thrower_id, grenade_type: thr.grenade_type, throw_tick: thr.tick, detonate_tick: null, x: 0, y: 0, z: 0, expire_tick: null, trajectory: [] });
      continue;
    }

    usedDet.add(bestIdx);
    const det = detonations[bestIdx];

    // Nearest-neighbour expire lookup (200-unit radius)
    let expireTick: number | null = null;
    const EXPIRE_MATCH_DIST_SQ = 200 ** 2;
    for (const c of expireList.get(det.round_number) ?? []) {
      const dx = c.x - det.x;
      const dy = c.y - det.y;
      if (dx * dx + dy * dy <= EXPIRE_MATCH_DIST_SQ) {
        if (expireTick === null || c.tick < expireTick) expireTick = c.tick;
      }
    }
    if (expireTick === null) {
      const base = EFFECT_TICKS[thr.grenade_type] ?? 64;
      expireTick = det.tick + Math.round(base * tickScale);
    }

    grenades.push({ round_number: thr.round_number, thrower_id: thr.thrower_id, grenade_type: thr.grenade_type, throw_tick: thr.tick, detonate_tick: det.tick, x: det.x, y: det.y, z: det.z, expire_tick: expireTick, trajectory: [] });
  }

  // ---- Build trajectory tracks -------------------------------------------
  const trackIndex = new Map<string, TrackPt[][]>();
  if (rawTraj.length > 0) {
    const rawByKey = new Map<string, TrackPt[]>();
    for (const r of rawTraj) {
      const key = `${r.gtype}:${r.rn}`;
      const list = rawByKey.get(key) ?? [];
      list.push({ tick: r.tick, x: r.x, y: r.y, z: r.z, thrower_id: r.thrower_id });
      rawByKey.set(key, list);
    }
    for (const [key, bucket] of rawByKey) {
      bucket.sort((a, b) => a.tick - b.tick);
      trackIndex.set(key, buildTracks(bucket));
    }
  }

  // ---- Fallback: synthesize from tracks when no throw-based detonations ---
  if (trackIndex.size > 0 && !grenades.some((g) => g.detonate_tick !== null)) {
    grenades = [];
    for (const [key, tracks] of trackIndex) {
      const [gtype, rnStr] = key.split(':');
      const round = Number(rnStr);
      for (const track of tracks) {
        if (track.length < 2) continue;
        const last = track[track.length - 1];
        const thrower = track.find((p) => p.thrower_id)?.thrower_id ?? 0;
        const base = EFFECT_TICKS[gtype] ?? 64;
        grenades.push({ round_number: round, thrower_id: thrower, grenade_type: gtype as GrenadeType, throw_tick: track[0].tick, detonate_tick: last.tick, x: last.x, y: last.y, z: last.z, expire_tick: last.tick + Math.round(base * tickScale), trajectory: sampleTrack(track) });
      }
    }
    grenades.sort((a, b) => a.throw_tick - b.throw_tick);
  }

  // ---- Attach trajectory waypoints to throw-based grenades ---------------
  if (trackIndex.size > 0) {
    for (const g of grenades) {
      if ((g.trajectory && g.trajectory.length > 0) || g.detonate_tick === null) continue;
      const allTracks = trackIndex.get(`${g.grenade_type}:${g.round_number}`) ?? [];
      if (allTracks.length === 0) continue;

      const candidates: TrackPt[][] = [];
      for (const track of allTracks) {
        const window = track.filter(
          (r) => g.throw_tick <= r.tick && r.tick <= (g.detonate_tick as number)
            && !(r.thrower_id && g.thrower_id && r.thrower_id !== g.thrower_id),
        );
        if (window.length >= 2) candidates.push(window);
      }
      if (candidates.length === 0) continue;

      let best = candidates[0];
      let bestD = Infinity;
      for (const pts of candidates) {
        const tail = pts[pts.length - 1];
        const d = (tail.x - g.x) ** 2 + (tail.y - g.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = pts;
        }
      }
      g.trajectory = sampleTrack(best);
    }
  }

  return grenades;
}
