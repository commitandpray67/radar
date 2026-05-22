import type { RoundInfo, PlayerInfo, TeamSessionDetail } from '../types';

// Collapse consecutive round numbers into ranges, e.g. [2,3,4,7] → "2–4, 7"
export function toRangeString(nums: number[]): string {
  if (nums.length === 0) return '';
  const s = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let lo = s[0], hi = s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i] === hi + 1) { hi = s[i]; }
    else {
      parts.push(lo === hi ? `${lo}` : `${lo}–${hi}`);
      lo = hi = s[i];
    }
  }
  parts.push(lo === hi ? `${lo}` : `${lo}–${hi}`);
  return parts.join(', ');
}

// Round number after which sides swap (i.e. the 12th non-knife round, MR12).
// Returns null if the match is ≤12 rounds (no halftime to worry about).
export function getHalftimeRound(displayRounds: RoundInfo[]): number | null {
  return displayRounds.length > 12 ? displayRounds[11].round_number : null;
}

// ---------------------------------------------------------------------------
// Economy classification
// ---------------------------------------------------------------------------

export type EcoClass = 'pistol' | 'full' | 'force' | 'half' | 'eco';

/** Classify a single team's equipment value into a buy category.
 *  Note: this does NOT detect pistol rounds — callers that need to distinguish
 *  pistols (round 1 / round 13) must use `classifyRoundEco` instead. */
export function classifyEco(teamValue: number): EcoClass {
  if (teamValue >= 18000) return 'full';
  if (teamValue >= 9000)  return 'force';
  if (teamValue >= 4000)  return 'half';
  return 'eco';
}

/** Pistol rounds = first non-knife round of each half. */
export function getPistolRoundNumbers(displayRounds: RoundInfo[]): number[] {
  if (displayRounds.length === 0) return [];
  const out: number[] = [displayRounds[0].round_number];
  if (displayRounds.length > 12) out.push(displayRounds[12].round_number);
  return out;
}

/** Classify a round for the given side, treating pistol rounds specially. */
export function classifyRoundEco(
  round: RoundInfo,
  side: 'CT' | 'T',
  pistolRoundNumbers: number[],
): EcoClass {
  if (pistolRoundNumbers.includes(round.round_number)) return 'pistol';
  const val = side === 'CT' ? (round.ct_equip_value ?? 0) : (round.t_equip_value ?? 0);
  return classifyEco(val);
}

/** Human-readable label for an EcoClass. */
export const ECO_LABEL: Record<EcoClass, string> = {
  pistol: 'Pistol',
  full:   'Full buy',
  force:  'Force buy',
  half:   'Half buy',
  eco:    'Eco',
};

/** CSS colour for each eco class. */
export const ECO_COLOR: Record<EcoClass, string> = {
  pistol: '#c0c0c0',  // silver — distinct from buy categories
  full:   '#3a9a4a',  // green
  force:  '#c8a020',  // yellow
  half:   '#c06030',  // orange
  eco:    '#8a2020',  // dark red
};

/** Filter a round list to those where the given side's economy matches cls. */
export function getRoundsForEcoClass(
  rounds: RoundInfo[],
  side: 'CT' | 'T',
  cls: EcoClass,
): RoundInfo[] {
  const pistolRns = getPistolRoundNumbers(rounds);
  return rounds.filter((r) => classifyRoundEco(r, side, pistolRns) === cls);
}

/** Toggle all rounds of (side, cls) in/out of the given selection set. */
export function toggleEcoRounds(
  rounds: RoundInfo[],
  side: 'CT' | 'T',
  cls: EcoClass,
  current: number[],
): number[] {
  const matching = getRoundsForEcoClass(rounds, side, cls).map((r) => r.round_number);
  if (matching.length === 0) return current;
  const allSelected = matching.every((n) => current.includes(n));
  if (allSelected) {
    return current.filter((n) => !matching.includes(n));
  }
  return [...new Set([...current, ...matching])];
}

// ---------------------------------------------------------------------------
// Team-session helpers (rounds span multiple demos)
// ---------------------------------------------------------------------------

/** Composite key for a round in team mode: "<demoId>:<roundNumber>". */
export function teamRoundKey(demoId: string, roundNumber: number): string {
  return `${demoId}:${roundNumber}`;
}

/** Compute the team's side in a round, accounting for halftime swap. */
function sideAfterHalftime(initial: 'CT' | 'T', isFirstHalf: boolean): 'CT' | 'T' {
  if (isFirstHalf) return initial;
  return initial === 'CT' ? 'T' : 'CT';
}

/** Group team-session rounds by demo (preserves demo_ids order; knife rounds filtered). */
export function getTeamRoundsByDemo(
  teamSession: TeamSessionDetail,
): { demoId: string; matchNum: number; filename: string; rounds: RoundInfo[] }[] {
  const byDemo = new Map<string, RoundInfo[]>();
  for (const r of teamSession.rounds) {
    if (r.is_knife_round) continue;
    if (!byDemo.has(r.demo_id)) byDemo.set(r.demo_id, []);
    byDemo.get(r.demo_id)!.push(r);
  }
  return teamSession.demo_ids.map((demoId, idx) => ({
    demoId,
    matchNum: idx + 1,
    filename: teamSession.demos.find((d) => d.id === demoId)?.filename ?? demoId.slice(0, 8),
    rounds: byDemo.get(demoId) ?? [],
  }));
}

/** Composite keys for rounds where the team played `side` with eco class `cls`. */
export function getTeamEcoMatches(
  teamSession: TeamSessionDetail,
  side: 'CT' | 'T',
  cls: EcoClass,
): string[] {
  const out: string[] = [];
  for (const group of getTeamRoundsByDemo(teamSession)) {
    const initial = teamSession.team_sides[group.demoId];
    if (!initial) continue;
    const pistolRns = getPistolRoundNumbers(group.rounds);
    group.rounds.forEach((r, idx) => {
      const teamSide = sideAfterHalftime(initial, idx < 12);
      if (teamSide !== side) return;
      if (classifyRoundEco(r, teamSide, pistolRns) !== cls) return;
      out.push(teamRoundKey(group.demoId, r.round_number));
    });
  }
  return out;
}

/** Toggle all team-perspective (side, cls) rounds in/out of a composite-key set. */
export function toggleTeamEcoRounds(
  teamSession: TeamSessionDetail,
  side: 'CT' | 'T',
  cls: EcoClass,
  current: string[],
): string[] {
  const matching = getTeamEcoMatches(teamSession, side, cls);
  if (matching.length === 0) return current;
  const matchSet = new Set(matching);
  const allSelected = matching.every((k) => current.includes(k));
  if (allSelected) {
    return current.filter((k) => !matchSet.has(k));
  }
  return [...new Set([...current, ...matching])];
}

/** Filter players to the team roster (core + extended).
 *
 * player_id is SteamID64, which exceeds JS's safe-integer range (2^53), so the
 * number parsed from JSON loses precision. core_roster is sent as strings to
 * preserve the exact value. We convert both to Number here so they round the
 * same way and compare consistently. */
export function filterPlayersToRoster(
  players: PlayerInfo[],
  teamSession: TeamSessionDetail | null,
): PlayerInfo[] {
  if (!teamSession) return players;
  const roster = new Set<number>(
    [...teamSession.core_roster, ...teamSession.extended_roster].map((s) => Number(s)),
  );
  return players.filter((p) => roster.has(p.player_id));
}
