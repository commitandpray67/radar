/**
 * useRoundPositions — fetches player positions for the active round on demand.
 *
 * Instead of loading all positions for the entire demo at once (~300K rows),
 * we fetch only the current round's positions whenever activeRound changes.
 * This keeps the initial load fast and browser memory usage flat.
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/demoStore';
import { getPositions } from '../utils/api';

export function useRoundPositions(): void {
  const demo              = useAppStore((s) => s.demo);
  const activeRound       = useAppStore((s) => s.activeRound);
  const setPositions      = useAppStore((s) => s.setPositions);
  const setPositionsLoading = useAppStore((s) => s.setPositionsLoading);

  // Track the last fetch so stale responses from slow requests don't overwrite
  // a newer round's data.
  const latestRoundRef = useRef<number | null>(null);

  useEffect(() => {
    if (!demo || activeRound === null) return;

    latestRoundRef.current = activeRound;
    setPositionsLoading(true);

    getPositions(demo.id, { round_number: activeRound })
      .then((positions) => {
        // Discard if a newer round was requested while this was in-flight
        if (latestRoundRef.current !== activeRound) return;
        setPositions(positions, [activeRound]);
      })
      .catch((err) => {
        console.error('Failed to load positions for round', activeRound, err);
      })
      .finally(() => {
        if (latestRoundRef.current === activeRound) {
          setPositionsLoading(false);
        }
      });
  }, [demo?.id, activeRound]); // eslint-disable-line react-hooks/exhaustive-deps
}
