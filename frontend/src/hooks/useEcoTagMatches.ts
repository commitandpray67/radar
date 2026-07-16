/**
 * useEcoTagMatches — precompute the matching rounds for every eco-filter tag
 * in a single memoized pass.
 *
 * Both the multi-round and heatmap control bars render ~10 eco tags and used to
 * call getTeamEcoMatches / getRoundsForEcoClass inline inside `.map(ECO_TAGS)`
 * — i.e. a full rounds (and, in team mode, all-demos) scan per tag, on every
 * render. This hook does it once and returns a lookup keyed by `${side}-${cls}`.
 *
 * Team-session mode → values are composite "demoId:round" keys.
 * Single-demo mode  → values are round numbers.
 */

import { useMemo } from 'react';
import {
  ECO_TAGS, getRoundsForEcoClass, getTeamEcoMatches,
  type RoundSideMap,
} from '../utils/roundUtils';
import type { PlayerInfo, RoundInfo, TeamSessionDetail } from '../types';

export type EcoTagMatches = Map<string, Array<string | number>>;

export function useEcoTagMatches(params: {
  teamSession: TeamSessionDetail | null;
  nonKnifeRounds: RoundInfo[];
  selectedPlayers: PlayerInfo[];
  sideMap: RoundSideMap;
}): EcoTagMatches {
  const { teamSession, nonKnifeRounds, selectedPlayers, sideMap } = params;
  return useMemo(() => {
    const out: EcoTagMatches = new Map();
    for (const { side, cls } of ECO_TAGS) {
      const key = `${side}-${cls}`;
      if (teamSession) {
        out.set(key, getTeamEcoMatches(teamSession, side, cls, sideMap));
      } else {
        out.set(
          key,
          getRoundsForEcoClass(nonKnifeRounds, side, cls, selectedPlayers, sideMap)
            .map((r) => r.round_number),
        );
      }
    }
    return out;
  }, [teamSession, nonKnifeRounds, selectedPlayers, sideMap]);
}
