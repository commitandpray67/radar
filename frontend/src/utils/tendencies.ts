/**
 * tendencies — bucket each player's rounds by buy type for the tendency report.
 *
 * For a chosen side (CT by default), classify every round the player actually
 * played on that side (from the authoritative round-sides map) into:
 *   - ecoHalf : the side's team buy was eco or half
 *   - full    : full buy
 *   - awp     : rounds where the player carried an AWP (any buy)
 * Each bucket then feeds one heatmap request per player.
 *
 * Pure functions — all inputs come from data the store already holds.
 */

import type { PlayerStateEvent, RoundInfo } from '../types';
import type { RoundSideMap } from './roundUtils';
import { classifyRoundEco, getPistolRoundNumbers } from './roundUtils';

/** A round reference that works in both single-demo and team-session modes. */
export interface TendencyRoundRef {
  demoId: string;
  roundNumber: number;
}

export interface ReportPlayer {
  /** Exact SteamID64 string — keys round-sides lookups and the team heatmap API. */
  key: string;
  /** SteamID64 as a JS number (rounded above 2^53) — matches other JSON numbers. */
  num: number;
  /** players-table row id — required by the single-demo heatmap API. */
  dbId?: number;
  name: string;
}

export interface PlayerTendencyBuckets {
  player: ReportPlayer;
  ecoHalf: TendencyRoundRef[];
  full: TendencyRoundRef[];
  awp: TendencyRoundRef[];
}

/** Rounds (as "demoId:rn" keys) in which each player carried an AWP. */
export function buildAwpRounds(
  stateEventsByDemo: { demoId: string; events: PlayerStateEvent[] }[],
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const { demoId, events } of stateEventsByDemo) {
    for (const ev of events) {
      if (ev.event_type !== 'equip') continue;
      if ((ev.weapon || '').toLowerCase() !== 'awp') continue;
      let set = out.get(ev.player_id);
      if (!set) {
        set = new Set<string>();
        out.set(ev.player_id, set);
      }
      set.add(`${demoId}:${ev.round_number}`);
    }
  }
  return out;
}

/**
 * Build per-player buy-type buckets for one side.
 *
 * `roundsByDemo` carries each demo's rounds (single-demo mode passes one entry);
 * `sideMap` is the authoritative per-round side data (demoId → rn → pid → side).
 * Rounds without side data for a player are skipped rather than guessed.
 */
export function buildTendencyBuckets(opts: {
  side: 'CT' | 'T';
  players: ReportPlayer[];
  roundsByDemo: { demoId: string; rounds: RoundInfo[] }[];
  sideMap: RoundSideMap;
  awpRounds: Map<number, Set<string>>;
}): PlayerTendencyBuckets[] {
  const { side, players, roundsByDemo, sideMap, awpRounds } = opts;
  const buckets: PlayerTendencyBuckets[] = players.map((p) => ({
    player: p,
    ecoHalf: [],
    full: [],
    awp: [],
  }));

  for (const { demoId, rounds } of roundsByDemo) {
    const nonKnife = rounds.filter((r) => !r.is_knife_round);
    const pistols = getPistolRoundNumbers(nonKnife);
    const demoSides = sideMap[demoId];
    if (!demoSides) continue;

    for (const r of nonKnife) {
      const roundSides = demoSides[String(r.round_number)];
      if (!roundSides) continue;
      const cls = classifyRoundEco(r, side, pistols);
      const ref: TendencyRoundRef = { demoId, roundNumber: r.round_number };
      const awpKey = `${demoId}:${r.round_number}`;

      for (const b of buckets) {
        if (roundSides[b.player.key] !== side) continue;
        if (cls === 'eco' || cls === 'half') b.ecoHalf.push(ref);
        else if (cls === 'full') b.full.push(ref);
        if (awpRounds.get(b.player.num)?.has(awpKey)) b.awp.push(ref);
      }
    }
  }
  return buckets;
}

/** Run async jobs with bounded concurrency, reporting each completion. */
export async function runLimited<T>(
  jobs: (() => Promise<T>)[],
  limit: number,
  onOneDone?: () => void,
): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array(jobs.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = await jobs[i]();
      } catch {
        results[i] = null;
      }
      onOneDone?.();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, () => worker()),
  );
  return results;
}
