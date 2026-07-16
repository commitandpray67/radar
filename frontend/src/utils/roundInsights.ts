/**
 * roundInsights — per-round bomb-site and economy analysis, derived entirely
 * from data the store already holds after a demo loads (rounds carry bomb ticks
 * + equip values + winner; bomb_planted events carry the site in `weapon`).
 *
 * Pure functions so they're trivially testable and cheap to memoize.
 */

import type { GameEvent, RoundInfo } from '../types';
import {
  classifyRoundEco, getPistolRoundNumbers, type EcoClass,
} from './roundUtils';

export interface RoundInsight {
  roundNumber: number;
  site: 'A' | 'B' | null;
  planted: boolean;
  defused: boolean;
  exploded: boolean;
  winner: 'CT' | 'T' | null;
  winReason: string | null;
  ctBuy: EcoClass;
  tBuy: EcoClass;
  ctEquip: number;
  tEquip: number;
}

/** Build a per-round insight list (knife rounds excluded). */
export function buildRoundInsights(
  rounds: RoundInfo[],
  events: GameEvent[],
): RoundInsight[] {
  const nonKnife = rounds.filter((r) => !r.is_knife_round);
  const pistolRns = getPistolRoundNumbers(nonKnife);

  // Plant site per round from the bomb_planted event's `weapon` field ('A'/'B').
  const siteByRound = new Map<number, 'A' | 'B'>();
  for (const e of events) {
    if (e.event_type === 'bomb_planted') {
      const w = (e.weapon || '').toUpperCase();
      if (w === 'A' || w === 'B') siteByRound.set(e.round_number, w);
    }
  }

  return nonKnife.map((r) => ({
    roundNumber: r.round_number,
    site: siteByRound.get(r.round_number) ?? null,
    planted: r.bomb_planted_tick != null,
    defused: r.bomb_defused_tick != null,
    exploded: r.bomb_exploded_tick != null,
    winner: r.winner_team === 'CT' || r.winner_team === 'T' ? r.winner_team : null,
    winReason: r.win_reason || null,
    ctBuy: classifyRoundEco(r, 'CT', pistolRns),
    tBuy: classifyRoundEco(r, 'T', pistolRns),
    ctEquip: r.ct_equip_value ?? 0,
    tEquip: r.t_equip_value ?? 0,
  }));
}

export interface SiteSummary {
  a: number;
  b: number;
  noPlant: number;
  total: number;
  /** Post-plant win rate for the T side (bomb stayed / exploded) per site. */
  postPlantTWinRate: { a: number | null; b: number | null };
}

/** Count A/B/no-plant splits and post-plant T win rate per site. */
export function summarizeSites(list: RoundInsight[]): SiteSummary {
  let a = 0, b = 0, noPlant = 0;
  const plantWins = { A: 0, B: 0 };
  const plantTotal = { A: 0, B: 0 };
  for (const r of list) {
    if (!r.planted || !r.site) { noPlant += 1; continue; }
    if (r.site === 'A') a += 1; else b += 1;
    plantTotal[r.site] += 1;
    // After a plant, the T side "wins" unless the bomb is defused.
    if (!r.defused) plantWins[r.site] += 1;
  }
  return {
    a, b, noPlant, total: list.length,
    postPlantTWinRate: {
      a: plantTotal.A ? plantWins.A / plantTotal.A : null,
      b: plantTotal.B ? plantWins.B / plantTotal.B : null,
    },
  };
}

/** Win/played counts per buy class for one side. */
export function winRateByBuy(
  list: RoundInsight[],
  side: 'CT' | 'T',
): Record<EcoClass, { n: number; wins: number }> {
  const out: Record<EcoClass, { n: number; wins: number }> = {
    pistol: { n: 0, wins: 0 },
    full: { n: 0, wins: 0 },
    force: { n: 0, wins: 0 },
    half: { n: 0, wins: 0 },
    eco: { n: 0, wins: 0 },
  };
  for (const r of list) {
    const cls = side === 'CT' ? r.ctBuy : r.tBuy;
    out[cls].n += 1;
    if (r.winner === side) out[cls].wins += 1;
  }
  return out;
}
