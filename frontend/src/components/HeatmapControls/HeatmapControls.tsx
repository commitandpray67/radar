/**
 * HeatmapControls — panel for configuring and triggering heatmap generation.
 *
 * Shows:
 *  - Mode toggle (heatmap on/off)
 *  - Player selector
 *  - Selected rounds list (controlled via RoundPanel multi-select)
 *  - Team filter
 *  - Layer selector (multi-level maps)
 *  - Generate button
 *  - Status / error display
 */

import React, { useCallback } from 'react';
import { useAppStore } from '../../store/demoStore';
import { generateHeatmap } from '../../utils/api';
import styles from './HeatmapControls.module.css';

const HeatmapControls: React.FC = () => {
  const demo             = useAppStore((s) => s.demo);
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
  const setHeatmapResult     = useAppStore((s) => s.setHeatmapResult);
  const setHeatmapLoading    = useAppStore((s) => s.setHeatmapLoading);
  const setHeatmapError      = useAppStore((s) => s.setHeatmapError);
  const setTeamFilter        = useAppStore((s) => s.setHeatmapTeamFilter);
  const setActiveLayer       = useAppStore((s) => s.setActiveLayer);
  const togglePlayerSel      = useAppStore((s) => s.togglePlayerSelection);
  const setSelectedPlayers   = useAppStore((s) => s.setSelectedPlayers);

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
      const result = await generateHeatmap(demo.id, {
        player_ids: Array.from(selectedPlayers),
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
    demo, canGenerate, selectedPlayers, heatmapRounds, activeLayer, teamFilter,
    setHeatmapLoading, setHeatmapError, setHeatmapResult,
  ]);

  const clearHeatmap = () => {
    setHeatmapResult(null);
    setHeatmapError(null);
  };

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
          {/* Player selector */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Players</span>
              <button className={styles.smallBtn} onClick={() => setSelectedPlayers([])}>
                Clear
              </button>
            </div>
            <div className={styles.playerList}>
              {players.map((p) => (
                <button
                  key={p.player_id}
                  className={`${styles.playerChip} ${
                    selectedPlayers.has(p.player_id) ? styles.selected : ''
                  } ${p.initial_team === 'CT' ? styles.ct : styles.t}`}
                  onClick={() => togglePlayerSel(p.player_id)}
                >
                  <span className={styles.playerName}>{p.name}</span>
                  <span className={styles.playerTeam}>{p.initial_team}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Selected rounds summary */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Selected rounds</span>
              <span className={styles.pill}>{heatmapRounds.length}</span>
            </div>
            {heatmapRounds.length === 0 ? (
              <p className={styles.hint}>Click rounds in the left panel to select</p>
            ) : (
              <p className={styles.roundsSummary}>
                {heatmapRounds.sort((a, b) => a - b).join(', ')}
              </p>
            )}
          </div>

          {/* Team filter */}
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

          {/* Layer selector (only for multi-level maps) */}
          {currentMap?.is_multilevel && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}><span>Map layer</span></div>
              <div className={styles.btnGroup}>
                {currentMap.layers.map((la) => (
                  <button
                    key={la.label}
                    className={`${styles.filterBtn} ${
                      activeLayer === la.label ? styles.active : ''
                    }`}
                    onClick={() => setActiveLayer(la.label)}
                  >
                    {la.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {heatmapError && (
            <div className={styles.error}>{heatmapError}</div>
          )}

          {/* Sample count */}
          {heatmapResult && !heatmapError && (
            <p className={styles.resultMeta}>
              {heatmapResult.sample_count.toLocaleString()} position samples used
            </p>
          )}

          {/* Generate / Clear */}
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
