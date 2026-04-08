/**
 * HeatmapControls — panel for configuring and triggering heatmap generation.
 *
 * Design principles:
 *  - Team filter is implicit: selecting T/CT rounds for a player encodes the
 *    side; no separate "team filter" needed (it caused conflicts).
 *  - Per-player T / CT buttons are the primary way to scope by side.
 *  - Round quick-select (All / 1st half / 2nd half) covers the other cases.
 */

import React, { useCallback, useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import { generateHeatmap } from '../../utils/api';
import type { PlayerInfo } from '../../types';
import styles from './HeatmapControls.module.css';

// Collapse consecutive round numbers into ranges, e.g. [2,3,4,7] → "2–4, 7"
function toRangeString(nums: number[]): string {
  if (nums.length === 0) return '';
  const s = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let lo = s[0];
  let hi = s[0];
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

const HeatmapControls: React.FC = () => {
  const demo             = useAppStore((s) => s.demo);
  const rounds           = useAppStore((s) => s.rounds);
  const players          = useAppStore((s) => s.players);
  const isHeatmapMode    = useAppStore((s) => s.isHeatmapMode);
  const heatmapRounds    = useAppStore((s) => s.selectedRoundsForHeatmap);
  const heatmapLoading   = useAppStore((s) => s.heatmapLoading);
  const heatmapError     = useAppStore((s) => s.heatmapError);
  const heatmapResult    = useAppStore((s) => s.heatmapResult);
  const activeLayer      = useAppStore((s) => s.activeLayerLabel);
  const currentMap       = useAppStore((s) => s.currentMap);
  const selectedPlayers  = useAppStore((s) => s.selectedPlayerIds);

  const setHeatmapMode       = useAppStore((s) => s.setHeatmapMode);
  const setHeatmapRounds     = useAppStore((s) => s.setHeatmapRounds);
  const setHeatmapResult     = useAppStore((s) => s.setHeatmapResult);
  const setHeatmapLoading    = useAppStore((s) => s.setHeatmapLoading);
  const setHeatmapError      = useAppStore((s) => s.setHeatmapError);
  const setActiveLayer       = useAppStore((s) => s.setActiveLayer);
  const togglePlayerSel      = useAppStore((s) => s.togglePlayerSelection);
  const setSelectedPlayers   = useAppStore((s) => s.setSelectedPlayers);

  // ---------------------------------------------------------------------------
  // Round groups (derived from loaded round data)
  // ---------------------------------------------------------------------------

  const nonKnifeRounds = useMemo(
    () => rounds.filter((r) => !r.is_knife_round),
    [rounds],
  );

  // Halftime always after the 12th non-knife round (MR12).
  const halftimeBoundary = useMemo(
    () => (nonKnifeRounds.length > 12 ? nonKnifeRounds[11].round_number : Infinity),
    [nonKnifeRounds],
  );

  const allRoundNums   = useMemo(() => nonKnifeRounds.map((r) => r.round_number), [nonKnifeRounds]);
  const firstHalfNums  = useMemo(
    () => nonKnifeRounds.filter((r) => r.round_number <= halftimeBoundary).map((r) => r.round_number),
    [nonKnifeRounds, halftimeBoundary],
  );
  const secondHalfNums = useMemo(
    () => nonKnifeRounds.filter((r) => r.round_number > halftimeBoundary).map((r) => r.round_number),
    [nonKnifeRounds, halftimeBoundary],
  );

  // ---------------------------------------------------------------------------
  // Per-player side quick-select
  // ---------------------------------------------------------------------------

  /**
   * Auto-select the rounds in which `player` was on `side`, ensure they are
   * in the selection, and drop any already-selected players who were on the
   * opposing side (since two players can't be on the same team at the same time
   * as their opponent).
   *
   * No separate team_filter is sent — the round range already encodes which
   * side is relevant, avoiding filter conflicts.
   */
  const handleSelectSideRounds = useCallback(
    (player: PlayerInfo, side: 'T' | 'CT') => {
      const sideRounds = nonKnifeRounds
        .filter((r) => {
          const inFirstHalf = r.round_number <= halftimeBoundary;
          // After halftime teams swap; derive actual side from initial_team.
          const playerSide = inFirstHalf
            ? player.initial_team
            : player.initial_team === 'CT' ? 'T' : 'CT';
          return playerSide === side;
        })
        .map((r) => r.round_number);

      setHeatmapRounds(sideRounds);

      // Players with the same initial_team are always teammates (both halves).
      // Players with the opposite initial_team are always opponents.
      const oppInitialTeam = player.initial_team === 'CT' ? 'T' : 'CT';
      const newSelected = players
        .filter(
          (p) =>
            p.player_id === player.player_id ||
            (selectedPlayers.has(p.player_id) && p.initial_team !== oppInitialTeam),
        )
        .map((p) => p.player_id);
      setSelectedPlayers(newSelected);
    },
    [nonKnifeRounds, halftimeBoundary, players, selectedPlayers, setHeatmapRounds, setSelectedPlayers],
  );

  // ---------------------------------------------------------------------------
  // Generate / clear
  // ---------------------------------------------------------------------------

  const canGenerate =
    !!demo &&
    heatmapRounds.length > 0 &&
    selectedPlayers.size > 0 &&
    !heatmapLoading;

  const handleGenerate = useCallback(async () => {
    if (!demo || !canGenerate) return;
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      // Send DB row IDs — SteamID64s exceed JS Number.MAX_SAFE_INTEGER.
      const playerDbIds = players
        .filter((p) => selectedPlayers.has(p.player_id))
        .map((p) => p.id);
      const result = await generateHeatmap(demo.id, {
        player_ids: playerDbIds,
        round_numbers: heatmapRounds,
        layer_label: activeLayer || undefined,
        // team_filter intentionally omitted (null = both sides).
        // Round selection already encodes the relevant side.
        exclude_freeze_time: true,
        blur_sigma: 6.0,
      });
      setHeatmapResult(result);
    } catch (err) {
      setHeatmapError(err instanceof Error ? err.message : 'Heatmap generation failed');
      setHeatmapResult(null);
    } finally {
      setHeatmapLoading(false);
    }
  }, [
    demo, canGenerate, players, selectedPlayers, heatmapRounds, activeLayer,
    setHeatmapLoading, setHeatmapError, setHeatmapResult,
  ]);

  const clearHeatmap = useCallback(() => {
    setHeatmapResult(null);
    setHeatmapError(null);
  }, [setHeatmapResult, setHeatmapError]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.root}>
      {/* ── Mode toggle ──────────────────────────────────────────── */}
      <div className={styles.modeRow}>
        <span className={styles.modeLabel}>Heatmap mode</span>
        <button
          className={`${styles.toggleSwitch} ${isHeatmapMode ? styles.on : ''}`}
          onClick={() => {
            setHeatmapMode(!isHeatmapMode);
            if (!isHeatmapMode) clearHeatmap();
          }}
        >
          {isHeatmapMode ? 'ON' : 'OFF'}
        </button>
      </div>

      {isHeatmapMode && (
        <>
          {/* ── Players ──────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Players</span>
              {selectedPlayers.size > 0 && (
                <button className={styles.smallBtn} onClick={() => setSelectedPlayers([])}>
                  Clear
                </button>
              )}
            </div>

            <div className={styles.playerList}>
              {players.map((p, idx) => {
                const isSelected = selectedPlayers.has(p.player_id);
                const isCT = p.initial_team === 'CT';
                return (
                  <div key={p.player_id} className={styles.playerRow}>
                    {/* Chip toggles player in/out of selection */}
                    <button
                      className={[
                        styles.playerChip,
                        isSelected ? styles.selected : '',
                        isCT ? styles.ct : styles.t,
                      ].join(' ')}
                      onClick={() => togglePlayerSel(p.player_id)}
                      title={isSelected ? `Deselect ${p.name}` : `Select ${p.name}`}
                    >
                      <span className={styles.playerNum}>{idx + 1}</span>
                      <span className={styles.playerName}>{p.name}</span>
                    </button>

                    {/* Side quick-select: sets player + their half-specific rounds */}
                    <div className={styles.sideButtons}>
                      <button
                        className={`${styles.sideBtn} ${styles.tBtn}`}
                        onClick={() => handleSelectSideRounds(p, 'T')}
                        title={`Select rounds where ${p.name} plays as T`}
                      >
                        T
                      </button>
                      <button
                        className={`${styles.sideBtn} ${styles.ctBtn}`}
                        onClick={() => handleSelectSideRounds(p, 'CT')}
                        title={`Select rounds where ${p.name} plays as CT`}
                      >
                        CT
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className={styles.sideHint}>
              T / CT → auto-select that player's rounds for that side
            </p>
          </div>

          {/* ── Rounds ───────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Rounds</span>
              {heatmapRounds.length > 0 && (
                <span className={styles.pill}>{heatmapRounds.length} selected</span>
              )}
            </div>

            <div className={styles.quickSelectRow}>
              <button
                className={styles.quickBtn}
                onClick={() => setHeatmapRounds(allRoundNums)}
              >
                All
              </button>
              <button
                className={styles.quickBtn}
                onClick={() => setHeatmapRounds(firstHalfNums)}
                disabled={firstHalfNums.length === 0}
                title="Rounds 1–12"
              >
                1st half
              </button>
              <button
                className={styles.quickBtn}
                onClick={() => setHeatmapRounds(secondHalfNums)}
                disabled={secondHalfNums.length === 0}
                title="Rounds 13+"
              >
                2nd half
              </button>
              <button
                className={`${styles.quickBtn} ${styles.quickBtnClear}`}
                onClick={() => setHeatmapRounds([])}
                disabled={heatmapRounds.length === 0}
              >
                Clear
              </button>
            </div>

            {heatmapRounds.length === 0 ? (
              <p className={styles.hint}>
                Use buttons above, or click rounds in the left panel
              </p>
            ) : (
              <p className={styles.roundsSummary}>{toRangeString(heatmapRounds)}</p>
            )}
          </div>

          {/* ── Layer selector (multi-level maps only) ────────────── */}
          {currentMap?.is_multilevel && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}><span>Layer</span></div>
              <div className={styles.btnGroup}>
                {currentMap.layers.map((la) => (
                  <button
                    key={la.label}
                    className={`${styles.filterBtn} ${activeLayer === la.label ? styles.active : ''}`}
                    onClick={() => setActiveLayer(la.label)}
                  >
                    {la.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Error ────────────────────────────────────────────── */}
          {heatmapError && (
            <div className={styles.error}>{heatmapError}</div>
          )}

          {/* ── Result ───────────────────────────────────────────── */}
          {heatmapResult && !heatmapError && (
            <p className={heatmapResult.sample_count === 0 ? styles.warningMeta : styles.resultMeta}>
              {heatmapResult.sample_count === 0
                ? 'No data — try different rounds or players'
                : `${heatmapResult.sample_count.toLocaleString()} position samples`}
            </p>
          )}

          {/* ── Actions ──────────────────────────────────────────── */}
          <div className={styles.actionRow}>
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={!canGenerate}
              title={
                !demo ? 'No demo loaded' :
                selectedPlayers.size === 0 ? 'Select at least one player' :
                heatmapRounds.length === 0 ? 'Select at least one round' :
                undefined
              }
            >
              {heatmapLoading ? 'Generating…' : 'Generate heatmap'}
            </button>
            {heatmapResult && (
              <button className={styles.clearBtn} onClick={clearHeatmap}>
                Clear
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default HeatmapControls;
