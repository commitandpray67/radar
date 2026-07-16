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
  const teamSession            = useAppStore((s) => s.teamSession);
  const multiRoundTeamKeys     = useAppStore((s) => s.multiRoundTeamKeys);
  const setPositions           = useAppStore((s) => s.setPositions);
  const setPositionsLoading    = useAppStore((s) => s.setPositionsLoading);
  const setPositionsError      = useAppStore((s) => s.setPositionsError);

  // One staleness token PER effect: the three effects run different request
  // streams and a single shared ref lets one effect discard another's valid
  // response (or accept a stale one) during mode transitions.
  const singleKeyRef = useRef<string>('');
  const multiKeyRef = useRef<string>('');
  const teamKeyRef = useRef<string>('');

  // ── Single-round mode ────────────────────────────────────────────────────
  useEffect(() => {
    if (!demo || isMultiRoundMode || activeRound === null) return;

    const key = `single:${demo.id}:${activeRound}`;
    singleKeyRef.current = key;
    setPositionsLoading(true);

    const controller = new AbortController();

    getPositions(demo.id, { round_number: activeRound }, controller.signal)
      .then((positions) => {
        if (singleKeyRef.current !== key) return;
        setPositions(positions, [activeRound]);
        setPositionsError(null);
      })
      .catch((err) => {
        if (err?.name === 'CanceledError' || err?.name === 'AbortError') return;
        console.error('Failed to load positions for round', activeRound, err);
        if (singleKeyRef.current === key) setPositionsError('Failed to load positions for this round.');
      })
      .finally(() => {
        if (singleKeyRef.current === key) setPositionsLoading(false);
      });

    return () => { controller.abort(); };
  }, [demo?.id, activeRound, isMultiRoundMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Multi-round mode (single demo) ───────────────────────────────────────
  useEffect(() => {
    if (!demo || !isMultiRoundMode || teamSession || multiRoundRounds.length === 0) return;

    const key = `multi:${demo.id}:${multiRoundRounds.slice().sort().join(',')}`;
    multiKeyRef.current = key;
    setPositionsLoading(true);

    const controller = new AbortController();

    Promise.all(
      multiRoundRounds.map((rn) =>
        getPositions(demo.id, { round_number: rn }, controller.signal)
      )
    )
      .then((perRound: PlayerPosition[][]) => {
        if (multiKeyRef.current !== key) return;
        const merged = ([] as PlayerPosition[]).concat(...perRound);
        setPositions(merged, multiRoundRounds);
        setPositionsError(null);
      })
      .catch((err) => {
        if (err?.name === 'CanceledError' || err?.name === 'AbortError') return;
        console.error('Failed to load multi-round positions', err);
        if (multiKeyRef.current === key) setPositionsError('Failed to load positions.');
      })
      .finally(() => {
        if (multiKeyRef.current === key) setPositionsLoading(false);
      });

    return () => { controller.abort(); };
  }, [demo?.id, isMultiRoundMode, teamSession?.id, multiRoundRounds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Multi-round mode (team session, cross-demo) ──────────────────────────
  useEffect(() => {
    if (!isMultiRoundMode || !teamSession || multiRoundTeamKeys.length === 0) return;

    const sortedKeys = multiRoundTeamKeys.slice().sort();
    const key = `multi-team:${teamSession.id}:${sortedKeys.join(',')}`;
    teamKeyRef.current = key;
    setPositionsLoading(true);

    const controller = new AbortController();

    // Parse composite keys into (demoId, roundNumber) tuples
    const pairs = sortedKeys.map((k) => {
      const sep = k.indexOf(':');
      return { demoId: k.slice(0, sep), rn: parseInt(k.slice(sep + 1), 10) };
    });

    Promise.all(
      pairs.map(({ demoId, rn }) =>
        getPositions(demoId, { round_number: rn }, controller.signal)
      )
    )
      .then((perRound: PlayerPosition[][]) => {
        if (teamKeyRef.current !== key) return;
        // Tag each position with its demo_id (the API may not include it).
        const merged: PlayerPosition[] = [];
        perRound.forEach((rows, i) => {
          const demoId = pairs[i].demoId;
          for (const p of rows) merged.push({ ...p, demo_id: demoId } as PlayerPosition);
        });
        // Pass union of round numbers so tick index still indexes them all.
        const rns = Array.from(new Set(pairs.map((p) => p.rn)));
        setPositions(merged, rns);
        setPositionsError(null);
      })
      .catch((err) => {
        if (err?.name === 'CanceledError' || err?.name === 'AbortError') return;
        console.error('Failed to load team multi-round positions', err);
        if (teamKeyRef.current === key) setPositionsError('Failed to load positions.');
      })
      .finally(() => {
        if (teamKeyRef.current === key) setPositionsLoading(false);
      });

    return () => { controller.abort(); };
  }, [isMultiRoundMode, teamSession?.id, multiRoundTeamKeys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}
