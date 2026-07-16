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
import type { DemoRoundSides, RoundSideMap } from '../utils/roundUtils';

// demo_id is a content hash → its per-round sides are immutable, so cache them
// module-wide. This stops the two consumers (MultiRoundControls, HeatmapControls)
// from refetching /round-sides for every demo on each tab switch.
const _sideCache = new Map<string, DemoRoundSides>();

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

    const buildFromCache = (): RoundSideMap => {
      const map: RoundSideMap = {};
      for (const id of demoIds) {
        const cached = _sideCache.get(id);
        if (cached) map[id] = cached;
      }
      return map;
    };

    // Show whatever is already cached immediately; fetch only what's missing.
    setSideMap(buildFromCache());
    const missing = demoIds.filter((id) => !_sideCache.has(id));
    if (missing.length === 0) return () => { alive = false; controller.abort(); };

    Promise.all(
      missing.map((id) =>
        getRoundSides(id, controller.signal)
          .then((sides) => [id, sides] as const)
          .catch(() => [id, {} as DemoRoundSides] as const),
      ),
    ).then((entries) => {
      if (!alive) return;
      for (const [id, sides] of entries) _sideCache.set(id, sides);
      setSideMap(buildFromCache());
    });

    return () => {
      alive = false;
      controller.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return sideMap;
}
