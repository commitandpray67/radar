/**
 * useRoundPositions — fetches player positions on demand.
 *
 * Single-round mode: loads positions for activeRound only when it changes.
 * Multi-round mode:  loads positions for every selected round whenever
 *                    the selection changes, then merges them all into the store.
 *
 * This replaces the old "load all positions for the whole demo at once" approach
 * (~300K rows) with targeted per-round fetches (~5-15K rows each).
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/demoStore';
import { getPositions } from '../utils/api';
import type { PlayerPosition } from '../types';

export function useRoundPositions(): void {
  const demo                   = useAppStore((s) => s.demo);
  const activeRound            = useAppStore((s) => s.activeRound);
  const isMultiRoundMode       = useAppStore((s) => s.isMultiRoundMode);
  const multiRoundRounds       = useAppStore((s) => s.multiRoundSelectedRounds);
  const setPositions           = useAppStore((s) => s.setPositions);
  const setPositionsLoading    = useAppStore((s) => s.setPositionsLoading);

  // Used to discard stale responses when the selection changes mid-flight.
  const fetchKeyRef = useRef<string>('');

  // ── Single-round mode ────────────────────────────────────────────────────
  useEffect(() => {
    if (!demo || isMultiRoundMode || activeRound === null) return;

    const key = `single:${demo.id}:${activeRound}`;
    fetchKeyRef.current = key;
    setPositionsLoading(true);

    getPositions(demo.id, { round_number: activeRound })
      .then((positions) => {
        if (fetchKeyRef.current !== key) return;
        setPositions(positions, [activeRound]);
      })
      .catch((err) => console.error('Failed to load positions for round', activeRound, err))
      .finally(() => {
        if (fetchKeyRef.current === key) setPositionsLoading(false);
      });
  }, [demo?.id, activeRound, isMultiRoundMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Multi-round mode ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!demo || !isMultiRoundMode || multiRoundRounds.length === 0) return;

    const key = `multi:${demo.id}:${multiRoundRounds.slice().sort().join(',')}`;
    fetchKeyRef.current = key;
    setPositionsLoading(true);

    // Fetch each round in parallel, then merge into one array
    Promise.all(
      multiRoundRounds.map((rn) =>
        getPositions(demo.id, { round_number: rn })
      )
    )
      .then((perRound: PlayerPosition[][]) => {
        if (fetchKeyRef.current !== key) return;
        const merged = ([] as PlayerPosition[]).concat(...perRound);
        setPositions(merged, multiRoundRounds);
      })
      .catch((err) => console.error('Failed to load multi-round positions', err))
      .finally(() => {
        if (fetchKeyRef.current === key) setPositionsLoading(false);
      });
  }, [demo?.id, isMultiRoundMode, multiRoundRounds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}
