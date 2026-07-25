/**
 * Round extraction — TypeScript port of `backend/parser/_rounds.py`.
 *
 * Strategy (unchanged from Python):
 *   1. Pair every round_end with its immediately-preceding unused round_start.
 *   2. Drop transition rounds via reason=16 (warmup→match / half transitions).
 *   3. Drop remaining short rounds (< 13 s).
 *   4. Assign freeze-end + bomb ticks, infer missing winners from the bomb,
 *      detect knife rounds, and compute halftime-adjusted cumulative scores.
 */

import type { DemoSource, Row } from './source';
import type { ParsedRound, ParsedPosition } from './types';
import { buildRoundLookup, toInt } from './utils';

type WinnerTeam = 'CT' | 'T' | '';

/** Normalise a round-end winner field to 'CT' | 'T' | ''. Mirrors `_parse_winner`. */
function parseWinner(raw: unknown): WinnerTeam {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === '2' || s === 'T' || s === 'TERRORIST') return 'T';
  if (s === '3' || s === 'CT' || s === 'COUNTERTERRORIST') return 'CT';
  return '';
}

function tickOf(row: Row): number {
  return toInt(row.tick ?? 0);
}

function safeEvent(source: DemoSource, name: string, other: string[]): Row[] {
  try {
    return source.parseEvent(name, other);
  } catch {
    return [];
  }
}

export function extractRounds(source: DemoSource, tickRate = 64.0): ParsedRound[] {
  const MIN_ROUND_TICKS = Math.trunc(13 * tickRate);

  // ---- round_start -------------------------------------------------------
  let startRows: Row[];
  try {
    startRows = source.parseEvent('round_start', ['tick']);
  } catch {
    return [];
  }
  startRows = [...startRows].sort((a, b) => tickOf(a) - tickOf(b));
  if (startRows.length === 0) return [];

  // ---- round_end (round_end first, else round_officially_ended) ----------
  let endRows: Row[] = [];
  for (const name of ['round_end', 'round_officially_ended']) {
    try {
      const rows = source.parseEvent(name, ['tick', 'winner', 'reason']);
      if (rows.length > 0) {
        endRows = [...rows].sort((a, b) => tickOf(a) - tickOf(b));
        break;
      }
    } catch {
      /* try next */
    }
  }

  // ---- freeze-end + bomb events ------------------------------------------
  const freezeRows = safeEvent(source, 'round_freeze_end', ['tick'])
    .slice()
    .sort((a, b) => tickOf(a) - tickOf(b));
  const bombPlants = safeEvent(source, 'bomb_planted', ['tick']);
  const bombDefuses = safeEvent(source, 'bomb_defused', ['tick']);
  const bombExplodes = safeEvent(source, 'bomb_exploded', ['tick']);

  // ---- Pair each end with its closest preceding unused start -------------
  const startTicksSorted = startRows.map(tickOf).sort((a, b) => a - b);
  const usedStartTicks = new Set<number>();
  const pairs: Array<{ start: number; end: number; winner: WinnerTeam; reason: string }> = [];

  for (const endRow of endRows) {
    const endTick = tickOf(endRow);
    const winner = parseWinner(endRow.winner);
    const reason = String(endRow.reason ?? '');

    let bestStart: number | null = null;
    for (let i = startTicksSorted.length - 1; i >= 0; i--) {
      const st = startTicksSorted[i];
      if (st < endTick && !usedStartTicks.has(st)) {
        bestStart = st;
        break;
      }
    }
    if (bestStart === null) continue;
    usedStartTicks.add(bestStart);
    pairs.push({ start: bestStart, end: endTick, winner, reason });
  }

  pairs.sort((a, b) => a.start - b.start);

  // ---- Filter 1: reason=16 transitions -----------------------------------
  const kept1 = pairs.filter((p) => p.reason !== '16');
  // ---- Filter 2: short-duration fallback ---------------------------------
  const kept = kept1.filter((p) => p.end - p.start >= MIN_ROUND_TICKS);

  // ---- Build RoundInfo list ----------------------------------------------
  const rounds: ParsedRound[] = kept.map((p, i) => {
    const matchingFreeze = freezeRows.find(
      (r) => p.start <= tickOf(r) && tickOf(r) <= p.end,
    );
    const freezeEndTick = matchingFreeze ? tickOf(matchingFreeze) : p.start;
    return {
      round_number: i + 1,
      start_tick: p.start,
      end_tick: p.end,
      freeze_end_tick: freezeEndTick,
      winner_team: p.winner,
      win_reason: p.reason,
      ct_score: 0,
      t_score: 0,
      bomb_planted_tick: null,
      bomb_defused_tick: null,
      bomb_exploded_tick: null,
      is_knife_round: false,
      ct_equip_value: 0,
      t_equip_value: 0,
    };
  });

  // ---- Assign bomb ticks -------------------------------------------------
  const rnLookup = buildRoundLookup(rounds);
  const byRn = new Map<number, ParsedRound>(rounds.map((r) => [r.round_number, r]));
  const bombAssignments: Array<[Row[], 'bomb_planted_tick' | 'bomb_defused_tick' | 'bomb_exploded_tick']> = [
    [bombPlants, 'bomb_planted_tick'],
    [bombDefuses, 'bomb_defused_tick'],
    [bombExplodes, 'bomb_exploded_tick'],
  ];
  for (const [rows, attr] of bombAssignments) {
    for (const row of rows) {
      const tick = tickOf(row);
      const rn = rnLookup(tick);
      const round = byRn.get(rn);
      if (round) round[attr] = tick;
    }
  }

  // ---- Infer missing winner from bomb outcome ----------------------------
  for (const r of rounds) {
    if (r.winner_team) continue;
    if (r.bomb_exploded_tick !== null) {
      r.winner_team = 'T';
      r.win_reason = '1';
    } else if (r.bomb_defused_tick !== null) {
      r.winner_team = 'CT';
      r.win_reason = '7';
    }
  }

  // ---- Knife-round detection ---------------------------------------------
  let deathRows: Row[] = [];
  try {
    deathRows = source.parseEvent('player_death', ['tick', 'weapon']);
  } catch {
    deathRows = [];
  }
  const deathsByRound = new Map<number, Row[]>();
  for (const d of deathRows) {
    const rn = rnLookup(tickOf(d));
    if (rn) {
      const list = deathsByRound.get(rn) ?? [];
      list.push(d);
      deathsByRound.set(rn, list);
    }
  }
  const isKnife = (weapon: unknown): boolean => {
    const w = String(weapon ?? '').toLowerCase().replace(/^weapon_/, '');
    return w.startsWith('knife') || w === 'knifegg';
  };
  for (const r of rounds) {
    const kills = deathsByRound.get(r.round_number) ?? [];
    if (kills.length > 0 && kills.every((d) => isKnife(d.weapon))) {
      r.is_knife_round = true;
    }
  }

  // ---- Cumulative scores (halftime side-swap aware) ----------------------
  const nonKnife = rounds.filter((r) => !r.is_knife_round);
  const halftimeBoundary = nonKnife.length > 12 ? nonKnife[11].round_number : Infinity;
  let ctWins = 0;
  let tWins = 0;
  for (const r of rounds) {
    if (!r.is_knife_round) {
      const inFirstHalf = r.round_number <= halftimeBoundary;
      if (inFirstHalf) {
        if (r.winner_team === 'CT') ctWins += 1;
        else if (r.winner_team === 'T') tWins += 1;
      } else {
        // sides swapped: a CT-labelled win now belongs to the team that started T
        if (r.winner_team === 'T') ctWins += 1;
        else if (r.winner_team === 'CT') tWins += 1;
      }
    }
    r.ct_score = ctWins;
    r.t_score = tWins;
  }

  return rounds;
}

/**
 * Derive {player_id: team} from the first non-knife round's positions.
 * parse_player_info reflects post-halftime sides, so this overrides it.
 * Mirrors `_infer_initial_teams`. Keyed by numeric player_id (matches positions).
 */
export function inferInitialTeams(
  positions: ParsedPosition[],
  rounds: ParsedRound[],
): Map<number, 'CT' | 'T'> {
  const result = new Map<number, 'CT' | 'T'>();
  if (positions.length === 0 || rounds.length === 0) return result;

  const nonKnife = rounds.filter((r) => !r.is_knife_round);
  if (nonKnife.length === 0) return result;
  const firstRound = Math.min(...nonKnife.map((r) => r.round_number));

  for (const pos of positions) {
    if (pos.round_number === firstRound && !result.has(pos.player_id)) {
      const team = pos.team_num === 2 ? 'T' : pos.team_num === 3 ? 'CT' : null;
      if (team) result.set(pos.player_id, team);
    }
  }
  return result;
}
