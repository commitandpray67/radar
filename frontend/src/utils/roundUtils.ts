import type { RoundInfo } from '../types';

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

export type EcoClass = 'full' | 'force' | 'half' | 'eco';

/** Classify a single team's equipment value into a buy category. */
export function classifyEco(teamValue: number): EcoClass {
  if (teamValue >= 18000) return 'full';
  if (teamValue >= 9000)  return 'force';
  if (teamValue >= 4000)  return 'half';
  return 'eco';
}

/** Human-readable label for an EcoClass. */
export const ECO_LABEL: Record<EcoClass, string> = {
  full:  'Full buy',
  force: 'Force buy',
  half:  'Half buy',
  eco:   'Eco',
};

/** CSS colour for each eco class. */
export const ECO_COLOR: Record<EcoClass, string> = {
  full:  '#3a9a4a',  // green
  force: '#c8a020',  // yellow
  half:  '#c06030',  // orange
  eco:   '#8a2020',  // dark red
};

/** Filter a round list to those where the given side's economy matches cls. */
export function getRoundsForEcoClass(
  rounds: RoundInfo[],
  side: 'CT' | 'T',
  cls: EcoClass,
): RoundInfo[] {
  return rounds.filter((r) => {
    const val = side === 'CT' ? (r.ct_equip_value ?? 0) : (r.t_equip_value ?? 0);
    return classifyEco(val) === cls;
  });
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
