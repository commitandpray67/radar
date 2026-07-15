/**
 * useRoundSides — fetches the authoritative CT/T side of each player per round
 * (from actual team_num) for the demos currently in scope.
 *
 * Single-demo mode: the active demo. Team-session mode: every demo in the
 * session. The result feeds the eco filters so buy-type selection is correct
 * through halftime *and* overtime, rather than guessing from round numbers.
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../store/demoStore';
import { getRoundSides } from '../utils/api';
import type { RoundSideMap } from '../utils/roundUtils';

export function useRoundSides(): RoundSideMap {
  const demo        = useAppStore((s) => s.demo);
  const teamSession = useAppStore((s) => s.teamSession);
  const [sideMap, setSideMap] = useState<RoundSideMap>({});

  // The set of demo ids we need sides for, as a stable string key.
  const demoIds = teamSession ? teamSession.demo_ids : demo ? [demo.id] : [];
  const key = demoIds.join(',');

  useEffect(() => {
    if (demoIds.length === 0) {
      setSideMap({});
      return;
    }
    let alive = true;
    const controller = new AbortController();

    Promise.all(
      demoIds.map((id) =>
        getRoundSides(id, controller.signal)
          .then((sides) => [id, sides] as const)
          .catch(() => [id, {}] as const),
      ),
    ).then((entries) => {
      if (!alive) return;
      const map: RoundSideMap = {};
      for (const [id, sides] of entries) map[id] = sides;
      setSideMap(map);
    });

    return () => {
      alive = false;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return sideMap;
}
