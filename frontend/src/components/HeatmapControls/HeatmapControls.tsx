/**
 * HeatmapControls — panel for configuring and triggering heatmap generation.
 *
 * Shows:
 *  - Mode toggle (heatmap on/off)
 *  - Player selector with per-player T/CT side quick-select buttons
 *  - Round quick-select (All, 1st Half, 2nd Half, Clear) + selected list
 *  - Team filter
 *  - Layer selector (multi-level maps)
 *  - Generate button
 *  - Status / error display
 */

import React, { useCallback, useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import { generateHeatmap } from '../../utils/api';
import type { PlayerInfo } from '../../types';
import styles from './HeatmapControls.module.css';

const HeatmapControls: React.FC = () => {
  const demo             = useAppStore((s) => s.demo);
  const rounds           = useAppStore((s) => s.rounds);
  const players          = useAppStore((s) => s.players);
  const isHeatmapMode    = useAppStore((s) => s.isHeatmapMode);
  const heatmapRounds    = useAppStore((s) => s.selectedRoundsForHeatmap);
  const heatmapLoading   = useAppStore((s) => s.heatmapLoading);
  const heatmapError     = useAppStore((s) => s.heatmapError);
  const heatmapResult    = useAppStore((s) => s.heatmapResult);
  const teamFilter       = useAppStore((s) => s.heatmapTeamFilter);
  const activeLayer      = useAppStore((s) => s.activeLayerLabel);
  const currentMap       = useAppStore((s) => s.currentMap);
  const selectedPlayers  = useAppStore((s) => s.selectedPlayerIds);

  const setHeatmapMode       = useAppStore((s) => s.setHeatmapMode);
  const setHeatmapRounds     = useAppStore((s) => s.setHeatmapRounds);
  const setHeatmapResult     = useAppStore((s) => s.setHeatmapResult);
  const setHeatmapLoading    = useAppStore((s) => s.setHeatmapLoading);
  const setHeatmapError      = useAppStore((s) => s.setHeatmapError);
  const setTeamFilter        = useAppStore((s) => s.setHeatmapTeamFilter);
  const setActiveLayer       = useAppStore((s) => s.setActiveLayer);
  const togglePlayerSel      = useAppStore((s) => s.togglePlayerSelection);
  const setSelectedPlayers   = useAppStore((s) => s.setSelectedPlayers);

  // ---------------------------------------------------------------------------
  // Round group memos
  // ---------------------------------------------------------------------------

  const nonKnifeRounds = useMemo(
    () => rounds.filter((r) => !r.is_knife_round),
    [rounds],
  );

  // Halftime boundary: after the 12th non-knife round (MR12)
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
   * Select all rounds where `player` was on `side`, ensure the player is
   * selected, and deselect players who were on the opposing side in those rounds
   * (since the two sides are mutually exclusive).
   *
   * Because teams swap at halftime, the "opposing team" is simply the set of
   * players whose initial_team differs from the clicked player's initial_team —
   * they will always be opponents regardless of which half we're looking at.
   */
  const handleSelectSideRounds = useCallback(
    (player: PlayerInfo, side: 'T' | 'CT') => {
      // Rounds where this player was on the chosen side
      const sideRounds = nonKnifeRounds
        .filter((r) => {
          const inFirstHalf = r.round_number <= halftimeBoundary;
          const playerSide = inFirstHalf
            ? player.initial_team
            : player.initial_team === 'CT' ? 'T' : 'CT';
          return playerSide === side;
        })
        .map((r) => r.round_number);

      setHeatmapRounds(sideRounds);

      // Keep: the clicked player + any already-selected player on the same team.
      // Remove: players whose initial_team is opposite (they are always opponents).
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
    demo &&
    heatmapRounds.length > 0 &&
    selectedPlayers.size > 0 &&
    !heatmapLoading;

  const handleGenerate = useCallback(async () => {
    if (!demo || !canGenerate) return;
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      // Send DB row IDs (small integers), not SteamID64s.
      // SteamID64s > Number.MAX_SAFE_INTEGER lose precision in JS JSON.
      const playerDbIds = players
        .filter((p) => selectedPlayers.has(p.player_id))
        .map((p) => p.id);
      const result = await generateHeatmap(demo.id, {
        player_ids: playerDbIds,
        round_numbers: heatmapRounds,
        layer_label: activeLayer || undefined,
        team_filter: teamFilter,
        exclude_freeze_time: true,
        blur_sigma: 3.0,
      });
      setHeatmapResult(result);
    } catch (err) {
      setHeatmapError(err instanceof Error ? err.message : 'Heatmap generation failed');
      setHeatmapResult(null);
    } finally {
      setHeatmapLoading(false);
    }
  }, [
    demo, canGenerate, players, selectedPlayers, heatmapRounds, activeLayer, teamFilter,
    setHeatmapLoading, setHeatmapError, setHeatmapResult,
  ]);

  const clearHeatmap = () => {
    setHeatmapResult(null);
    setHeatmapError(null);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className={styles.root}>
      {/* Mode toggle */}
      <div className={styles.modeRow}>
        <label className={styles.modeLabel}>Heatmap mode</label>
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
          {/* ── Players ─────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Players</span>
              <button className={styles.smallBtn} onClick={() => setSelectedPlayers([])}>
                Clear
              </button>
            </div>
            <div className={styles.playerList}>
              {players.map((p, idx) => {
                const isSelected = selectedPlayers.has(p.player_id);
                return (
                  <div key={p.player_id} className={styles.playerRow}>
                    {/* Main chip — click to toggle selection */}
                    <button
                      className={[
                        styles.playerChip,
                        isSelected ? styles.selected : '',
                        p.initial_team === 'CT' ? styles.ct : styles.t,
                      ].join(' ')}
                      onClick={() => togglePlayerSel(p.player_id)}
                      title={`Toggle ${p.name}`}
                    >
                      <span className={styles.playerNum}>{idx + 1}</span>
                      <span className={styles.playerName}>{p.name}</span>
                      <span className={styles.playerTeam}>{p.initial_team}</span>
                    </button>

                    {/* Side quick-select buttons */}
                    <div className={styles.sideButtons}>
                      <button
                        className={`${styles.sideBtn} ${styles.tBtn}`}
                        onClick={() => handleSelectSideRounds(p, 'T')}
                        title={`Select all rounds where ${p.name} plays as T (deselects opposing team)`}
                      >
                        T
                      </button>
                      <button
                        className={`${styles.sideBtn} ${styles.ctBtn}`}
                        onClick={() => handleSelectSideRounds(p, 'CT')}
                        title={`Select all rounds where ${p.name} plays as CT (deselects opposing team)`}
                      >
                        CT
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Rounds ──────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Rounds</span>
              <span className={styles.pill}>{heatmapRounds.length} selected</span>
            </div>

            {/* Quick-select row */}
            <div className={styles.quickSelectRow}>
              <button
                className={styles.quickBtn}
                onClick={() => setHeatmapRounds(allRoundNums)}
                title="Select all non-knife rounds"
              >
                All
              </button>
              <button
                className={styles.quickBtn}
                onClick={() => setHeatmapRounds(firstHalfNums)}
                disabled={firstHalfNums.length === 0}
                title="Select first-half rounds (1–12)"
              >
                1st half
              </button>
              <button
                className={styles.quickBtn}
                onClick={() => setHeatmapRounds(secondHalfNums)}
                disabled={secondHalfNums.length === 0}
                title="Select second-half rounds (13+)"
              >
                2nd half
              </button>
              <button
                className={`${styles.quickBtn} ${styles.quickBtnDanger}`}
                onClick={() => setHeatmapRounds([])}
              >
                Clear
              </button>
            </div>

            {heatmapRounds.length === 0 ? (
              <p className={styles.hint}>
                Click rounds in the left panel, or use the buttons above
              </p>
            ) : (
              <p className={styles.roundsSummary}>
                {[...heatmapRounds].sort((a, b) => a - b).join(', ')}
              </p>
            )}
          </div>

          {/* ── Team filter ─────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}><span>Team filter</span></div>
            <div className={styles.btnGroup}>
              {(['CT', 'T', null] as const).map((team) => (
                <button
                  key={team ?? 'both'}
                  className={`${styles.filterBtn} ${teamFilter === team ? styles.active : ''}`}
                  onClick={() => setTeamFilter(team)}
                >
                  {team ?? 'Both'}
                </button>
              ))}
            </div>
          </div>

          {/* ── Layer selector (multi-level maps only) ───────────── */}
          {currentMap?.is_multilevel && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}><span>Map layer</span></div>
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

          {/* ── Error ───────────────────────────────────────────── */}
          {heatmapError && (
            <div className={styles.error}>{heatmapError}</div>
          )}

          {/* ── Result meta ─────────────────────────────────────── */}
          {heatmapResult && !heatmapError && (
            <p className={heatmapResult.sample_count === 0 ? styles.warningMeta : styles.resultMeta}>
              {heatmapResult.sample_count === 0
                ? 'No samples — check filters'
                : `${heatmapResult.sample_count.toLocaleString()} position samples`}
            </p>
          )}

          {/* ── Actions ─────────────────────────────────────────── */}
          <div className={styles.actionRow}>
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={!canGenerate}
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
