/**
 * RoundPanel — left sidebar listing all rounds with metadata.
 * Supports single-click (jump to round) and multi-select for heatmap.
 */

import React, { useCallback, useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import type { RoundInfo } from '../../types';
import styles from './RoundPanel.module.css';

const TEAM_LABEL: Record<string, string> = {
  CT: 'CT',
  T: 'T',
  '': '—',
};

const WIN_REASON_SHORT: Record<string, string> = {
  '1': 'target bombed',
  '7': 'bomb defused',
  '8': 'CT win',
  '9': 'T win',
  '12': 'CT surrender',
  '13': 'T surrender',
};

function winReasonLabel(reason: string): string {
  return WIN_REASON_SHORT[reason] ?? reason ?? '';
}

const RoundPanel: React.FC = () => {
  const rounds           = useAppStore((s) => s.rounds);
  const activeRound      = useAppStore((s) => s.activeRound);
  const setActiveRound   = useAppStore((s) => s.setActiveRound);
  const isHeatmapMode    = useAppStore((s) => s.isHeatmapMode);
  const heatmapRounds    = useAppStore((s) => s.selectedRoundsForHeatmap);
  const toggleHeatmapRnd = useAppStore((s) => s.toggleHeatmapRound);

  const handleClick = useCallback(
    (round: RoundInfo) => {
      if (isHeatmapMode) {
        toggleHeatmapRnd(round.round_number);
      } else {
        setActiveRound(round.round_number);
      }
    },
    [isHeatmapMode, setActiveRound, toggleHeatmapRnd],
  );

  // Exclude knife rounds — must be computed before any early return (hooks rule).
  const displayRounds = useMemo(
    () => rounds.filter((r) => !r.is_knife_round),
    [rounds],
  );

  // Halftime separator: round after which ct_score + t_score first hits 12 (MR12).
  const halftimeAfter = useMemo(() => {
    for (const r of displayRounds) {
      if ((r.ct_score ?? 0) + (r.t_score ?? 0) === 12) return r.round_number;
    }
    return null;
  }, [displayRounds]);

  if (!rounds.length) {
    return (
      <div className={styles.empty}>
        <p>No rounds loaded</p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerText}>
          {isHeatmapMode ? 'Select rounds for heatmap' : 'Rounds'}
        </span>
        <span className={styles.count}>{displayRounds.length}</span>
      </div>
      <div className={styles.list}>
        {displayRounds.map((r) => {
          const isActive = r.round_number === activeRound && !isHeatmapMode;
          const isHeatmapSelected =
            isHeatmapMode && heatmapRounds.includes(r.round_number);

          return (
            <React.Fragment key={r.round_number}>
            {r.round_number === halftimeAfter && (
              <div className={styles.halftimeDivider}>
                <span className={styles.halftimeLabel}>halftime · sides swap</span>
              </div>
            )}
            <button
              key={r.round_number}
              className={[
                styles.roundRow,
                isActive ? styles.active : '',
                isHeatmapSelected ? styles.heatmapSelected : '',
              ].join(' ')}
              onClick={() => handleClick(r)}
              title={`Round ${r.round_number} — ${winReasonLabel(r.win_reason)}`}
            >
              {/* Round number */}
              <span className={styles.number}>{r.round_number}</span>

              {/* Winner badge */}
              <span
                className={[
                  styles.winner,
                  r.winner_team === 'CT' ? styles.winnerCT : '',
                  r.winner_team === 'T' ? styles.winnerT : '',
                ].join(' ')}
              >
                {TEAM_LABEL[r.winner_team]}
              </span>

              {/* Score */}
              <span className={styles.score}>
                {r.ct_score}:{r.t_score}
              </span>

              {/* Bomb indicator */}
              <span className={styles.bombIcons}>
                {r.bomb_planted_tick !== null && <span title="Bomb planted">💣</span>}
                {r.bomb_defused_tick !== null && <span title="Bomb defused">✅</span>}
                {r.bomb_exploded_tick !== null && <span title="Bomb exploded">💥</span>}
              </span>
            </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default RoundPanel;
