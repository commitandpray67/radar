/**
 * RoundPanel — left sidebar listing all rounds with metadata.
 * Supports single-click (jump to round) and multi-select for heatmap.
 */

import React, { useCallback, useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import type { RoundInfo } from '../../types';
import styles from './RoundPanel.module.css';

// Max reasonable equipment value per team (used to scale economy bars)
const ECONOMY_MAX = 20000;

function EconomyBars({ ct, t }: { ct: number; t: number }) {
  const ctPct = Math.min(100, (ct / ECONOMY_MAX) * 100);
  const tPct  = Math.min(100, (t  / ECONOMY_MAX) * 100);
  return (
    <span className={styles.econBars} title={`CT $${ct.toLocaleString()} · T $${t.toLocaleString()}`}>
      <span className={styles.econBarCT} style={{ width: `${ctPct}%` }} />
      <span className={styles.econBarT}  style={{ width: `${tPct}%` }} />
    </span>
  );
}

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

function getDisplaySideScore(
  roundNumber: number,
  halftimeRoundNumber: number | null,
  ctScore: number,
  tScore: number,
): { ct: number; t: number } {
  if (halftimeRoundNumber !== null && roundNumber > halftimeRoundNumber) {
    return { ct: tScore, t: ctScore };
  }
  return { ct: ctScore, t: tScore };
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

  // Halftime separator — use array index so knife-round filtering at the start
  // of the match doesn't shift the divider to the wrong position.
  // Standard MR12: first half = display rounds 1-12 (indices 0-11),
  //                second half starts at display round 13 (index 12).
  // OT is MR3: each 6-round OT period has a mid-swap at index 24+n*6+3.
  const halftimeRoundNumber = useMemo(() => {
    if (displayRounds.length < 12) return null;
    return displayRounds[11].round_number;  // round_number of the 12th non-knife round
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
        {displayRounds.map((r, idx) => {
          const displayNum = idx + 1;
          const score = getDisplaySideScore(
            r.round_number,
            halftimeRoundNumber,
            r.ct_score,
            r.t_score,
          );
          const isActive = r.round_number === activeRound && !isHeatmapMode;
          const isHeatmapSelected =
            isHeatmapMode && heatmapRounds.includes(r.round_number);

          // Compute which divider (if any) precedes this round.
          // idx 12        → regulation halftime
          // idx 24,30,36… → overtime period start (every 6, starting at 24)
          // idx 27,33,39… → overtime period side swap (3 rounds into each OT period)
          const otIdx = idx - 24;
          const otPeriod = otIdx >= 0 ? Math.floor(otIdx / 6) + 1 : 0;
          const showHalftime   = idx === 12;
          const showOtStart    = idx >= 24 && otIdx % 6 === 0;
          const showOtSwap     = idx >= 27 && (otIdx - 3) % 6 === 0;

          return (
            <React.Fragment key={r.round_number}>
            {showHalftime && (
              <div className={styles.halftimeDivider}>
                <span className={styles.halftimeLabel}>halftime · sides swap</span>
              </div>
            )}
            {showOtStart && (
              <div className={styles.overtimeDivider}>
                <span className={styles.overtimeLabel}>overtime {otPeriod}</span>
              </div>
            )}
            {showOtSwap && (
              <div className={styles.halftimeDivider}>
                <span className={styles.halftimeLabel}>ot {Math.floor((otIdx - 3) / 6) + 1} · sides swap</span>
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
              title={`Round ${displayNum} — ${winReasonLabel(r.win_reason)}`}
            >
              {/* Round number (re-indexed, knife rounds excluded) */}
              <span className={styles.number}>{displayNum}</span>

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

              {/* Economy + score column */}
              <span className={styles.midCol}>
                {/* Economy bars */}
                {(r.ct_equip_value !== undefined || r.t_equip_value !== undefined) ? (
                  <EconomyBars ct={r.ct_equip_value ?? 0} t={r.t_equip_value ?? 0} />
                ) : null}
                {/* Score */}
                <span className={styles.score}>{score.ct}:{score.t}</span>
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
