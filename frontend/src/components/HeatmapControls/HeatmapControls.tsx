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
import { generateHeatmap, generateTeamHeatmap } from '../../utils/api';
import {
  toRangeString, getHalftimeRound, toggleEcoRounds, getRoundsForEcoClass,
  getTeamEcoMatches, toggleTeamEcoRounds, filterPlayersToRoster,
  ECO_COLOR, ECO_LABEL, type EcoClass,
} from '../../utils/roundUtils';
import type { PlayerInfo } from '../../types';
import styles from './HeatmapControls.module.css';

const ECO_TAGS: { side: 'CT' | 'T'; cls: EcoClass; label: string }[] = [
  { side: 'CT', cls: 'full',  label: 'CT Full'  },
  { side: 'CT', cls: 'force', label: 'CT Force' },
  { side: 'CT', cls: 'half',  label: 'CT Half'  },
  { side: 'CT', cls: 'eco',   label: 'CT Eco'   },
  { side: 'T',  cls: 'full',  label: 'T Full'   },
  { side: 'T',  cls: 'force', label: 'T Force'  },
  { side: 'T',  cls: 'half',  label: 'T Half'   },
  { side: 'T',  cls: 'eco',   label: 'T Eco'    },
];

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
  const teamSession          = useAppStore((s) => s.teamSession);
  const teamHeatmapKeys      = useAppStore((s) => s.teamHeatmapRoundKeys);
  const setTeamHeatmapKeys   = useAppStore((s) => s.setTeamHeatmapRoundKeys);

  // ---------------------------------------------------------------------------
  // Player list: filter to team roster in team-session mode
  // ---------------------------------------------------------------------------
  const displayPlayers = useMemo(
    () => filterPlayersToRoster(players, teamSession),
    [players, teamSession],
  );

  // ---------------------------------------------------------------------------
  // Round groups (derived from loaded round data)
  // ---------------------------------------------------------------------------

  const nonKnifeRounds = useMemo(
    () => rounds.filter((r) => !r.is_knife_round),
    [rounds],
  );

  const teamKeySet = useMemo(() => new Set(teamHeatmapKeys), [teamHeatmapKeys]);

  const halftimeRound    = useMemo(() => getHalftimeRound(nonKnifeRounds), [nonKnifeRounds]);
  const halftimeBoundary = halftimeRound ?? Infinity;

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

  const canGenerate = teamSession
    ? teamHeatmapKeys.length > 0 && !heatmapLoading
    : (!!demo &&
        heatmapRounds.length > 0 &&
        selectedPlayers.size > 0 &&
        !heatmapLoading);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      let result;
      if (teamSession) {
        // Team session: cross-demo heatmap. Round keys are "demo_id:round_number".
        // team_filter "team" scopes positions to whichever side our team played
        // in each demo (CT or T resolved per-demo on the server).
        const teamRounds = teamHeatmapKeys.map((k) => {
          const sep = k.indexOf(':');
          return {
            demo_id: k.slice(0, sep),
            round_number: parseInt(k.slice(sep + 1), 10),
          };
        });
        result = await generateTeamHeatmap(teamSession.id, {
          rounds: teamRounds,
          player_ids: [],          // all team players; per-player filter is a TODO
          layer_label: activeLayer || undefined,
          exclude_freeze_time: true,
          blur_sigma: 6.0,
          team_filter: 'team',
        });
      } else {
        // Single-demo path
        if (!demo) return;
        const playerDbIds = players
          .filter((p) => selectedPlayers.has(p.player_id))
          .map((p) => p.id);
        result = await generateHeatmap(demo.id, {
          player_ids: playerDbIds,
          round_numbers: heatmapRounds,
          layer_label: activeLayer || undefined,
          exclude_freeze_time: true,
          blur_sigma: 6.0,
        });
      }
      setHeatmapResult(result);
    } catch (err) {
      setHeatmapError(err instanceof Error ? err.message : 'Heatmap generation failed');
      setHeatmapResult(null);
    } finally {
      setHeatmapLoading(false);
    }
  }, [
    canGenerate, teamSession, teamHeatmapKeys,
    demo, players, selectedPlayers, heatmapRounds, activeLayer,
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
            if (isHeatmapMode) clearHeatmap();
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
              {displayPlayers.map((p, idx) => {
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

                    {/* Side quick-select: sets player + their half-specific rounds.
                        Hidden in team-session mode where the eco filter bar serves
                        the equivalent role across all demos. */}
                    {!teamSession && (
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
                    )}
                  </div>
                );
              })}
            </div>

            {!teamSession && (
              <p className={styles.sideHint}>
                T / CT → auto-select that player's rounds for that side
              </p>
            )}
          </div>

          {/* ── Rounds ───────────────────────────────────────────── */}
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span>Rounds</span>
              {teamSession ? (
                teamHeatmapKeys.length > 0 && (
                  <span className={styles.pill}>{teamHeatmapKeys.length} selected</span>
                )
              ) : (
                heatmapRounds.length > 0 && (
                  <span className={styles.pill}>{heatmapRounds.length} selected</span>
                )
              )}
            </div>

            {teamSession ? (
              <>
                <div className={styles.quickSelectRow}>
                  <button
                    className={`${styles.quickBtn} ${styles.quickBtnClear}`}
                    onClick={() => setTeamHeatmapKeys([])}
                    disabled={teamHeatmapKeys.length === 0}
                  >
                    Clear
                  </button>
                </div>
                <div className={styles.ecoFilterBar}>
                  {ECO_TAGS.map(({ side, cls, label }) => {
                    const matching = getTeamEcoMatches(teamSession, side, cls);
                    if (matching.length === 0) return null;
                    const allOn = matching.every((k) => teamKeySet.has(k));
                    return (
                      <button
                        key={`${side}-${cls}`}
                        className={`${styles.ecoTag} ${allOn ? styles.ecoTagOn : ''}`}
                        style={{ '--eco-color': ECO_COLOR[cls] } as React.CSSProperties}
                        onClick={() => setTeamHeatmapKeys(toggleTeamEcoRounds(teamSession, side, cls, teamHeatmapKeys))}
                        title={`${label} — ${ECO_LABEL[cls]} (${matching.length} round${matching.length === 1 ? '' : 's'})`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {teamHeatmapKeys.length === 0 ? (
                  <p className={styles.hint}>
                    Click rounds from any match in the left panel, or use the eco filters
                  </p>
                ) : (
                  <p className={styles.roundsSummary}>
                    {teamHeatmapKeys.length} round{teamHeatmapKeys.length === 1 ? '' : 's'} across matches
                  </p>
                )}
              </>
            ) : (
              <>
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
                <div className={styles.ecoFilterBar}>
                  {ECO_TAGS.map(({ side, cls, label }) => {
                    const matchingNums = getRoundsForEcoClass(nonKnifeRounds, side, cls)
                      .map((r) => r.round_number);
                    if (matchingNums.length === 0) return null;
                    const allOn = matchingNums.every((n) => heatmapRounds.includes(n));
                    return (
                      <button
                        key={`${side}-${cls}`}
                        className={`${styles.ecoTag} ${allOn ? styles.ecoTagOn : ''}`}
                        style={{ '--eco-color': ECO_COLOR[cls] } as React.CSSProperties}
                        onClick={() => setHeatmapRounds(toggleEcoRounds(nonKnifeRounds, side, cls, heatmapRounds))}
                        title={`${label} — ${ECO_LABEL[cls]}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {heatmapRounds.length === 0 ? (
                  <p className={styles.hint}>
                    Use buttons above, or click rounds in the left panel
                  </p>
                ) : (
                  <p className={styles.roundsSummary}>{toRangeString(heatmapRounds)}</p>
                )}
              </>
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
            <>
              <p className={heatmapResult.sample_count === 0 ? styles.warningMeta : styles.resultMeta}>
                {heatmapResult.sample_count === 0
                  ? 'No data — try different rounds or players'
                  : `${heatmapResult.sample_count.toLocaleString()} position samples`}
              </p>
              {heatmapResult.sample_count > 0 && (
                <div className={styles.legend}>
                  <span className={styles.legendLabel}>Density</span>
                  <div className={styles.legendGradient} />
                  <div className={styles.legendTicks}>
                    <span>Low</span>
                    <span>High</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Actions ──────────────────────────────────────────── */}
          <div className={styles.actionRow}>
            <button
              className={styles.generateBtn}
              onClick={handleGenerate}
              disabled={!canGenerate}
              title={
                teamSession
                  ? (teamHeatmapKeys.length === 0
                      ? 'Select at least one round from any match'
                      : undefined)
                  : (!demo ? 'No demo loaded' :
                     selectedPlayers.size === 0 ? 'Select at least one player' :
                     heatmapRounds.length === 0 ? 'Select at least one round' :
                     undefined)
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
