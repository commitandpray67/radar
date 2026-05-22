/**
 * RoundPanel — left sidebar listing all rounds with metadata.
 *
 * Two display modes:
 *   - Single-demo: rounds from the current demo
 *   - Team session: rounds from ALL demos in the session, grouped by demo.
 *     Clicking a round from a different demo first swaps the active demo
 *     (loads its data into the standard store slots) before jumping to it.
 *
 * Supports single-click (jump to round) and multi-select for heatmap.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import { classifyRoundEco, getPistolRoundNumbers, ECO_COLOR, ECO_LABEL } from '../../utils/roundUtils';
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

interface RoundRowProps {
  round: RoundInfo;
  displayNum: number;
  halftimeRoundNumber: number | null;
  pistolRoundNumbers: number[];
  isActive: boolean;
  isHeatmapSelected: boolean;
  plantSite?: string;
  onClick: (r: RoundInfo) => void;
}

const RoundRow: React.FC<RoundRowProps> = ({
  round: r, displayNum, halftimeRoundNumber, pistolRoundNumbers,
  isActive, isHeatmapSelected, plantSite, onClick,
}) => {
  const score = getDisplaySideScore(r.round_number, halftimeRoundNumber, r.ct_score, r.t_score);
  const ctEco = classifyRoundEco(r, 'CT', pistolRoundNumbers);
  const tEco  = classifyRoundEco(r, 'T',  pistolRoundNumbers);
  const hasEco = r.ct_equip_value !== undefined || r.t_equip_value !== undefined;
  return (
    <button
      className={[
        styles.roundRow,
        isActive ? styles.active : '',
        isHeatmapSelected ? styles.heatmapSelected : '',
      ].join(' ')}
      onClick={() => onClick(r)}
      title={`Round ${displayNum} — ${winReasonLabel(r.win_reason)}`}
    >
      <span className={styles.number}>{displayNum}</span>
      <span className={[
        styles.winner,
        r.winner_team === 'CT' ? styles.winnerCT : '',
        r.winner_team === 'T' ? styles.winnerT : '',
      ].join(' ')}>
        {TEAM_LABEL[r.winner_team]}
      </span>
      <span className={styles.midCol}>
        {hasEco && (
          <EconomyBars ct={r.ct_equip_value ?? 0} t={r.t_equip_value ?? 0} />
        )}
        <span className={styles.score}>{score.ct}:{score.t}</span>
      </span>
      {hasEco && (
        <span className={styles.ecoDots}>
          <span
            className={styles.ecoDot}
            style={{ background: ECO_COLOR[ctEco] }}
            title={`CT: ${ECO_LABEL[ctEco]} ($${(r.ct_equip_value ?? 0).toLocaleString()})`}
          />
          <span
            className={styles.ecoDot}
            style={{ background: ECO_COLOR[tEco] }}
            title={`T: ${ECO_LABEL[tEco]} ($${(r.t_equip_value ?? 0).toLocaleString()})`}
          />
        </span>
      )}
      <span className={styles.bombIcons}>
        {r.bomb_planted_tick !== null && (
          <span title={plantSite ? `Bomb planted (site ${plantSite})` : 'Bomb planted'}>
            💣{plantSite && <span className={styles.siteBadge}>{plantSite}</span>}
          </span>
        )}
        {r.bomb_defused_tick !== null && <span title="Bomb defused">✅</span>}
        {r.bomb_exploded_tick !== null && <span title="Bomb exploded">💥</span>}
      </span>
    </button>
  );
};

// --- Single-demo round list with halftime/OT dividers ---
function renderSingleDemoRounds(
  rounds: RoundInfo[],
  activeRound: number | null,
  isHeatmapMode: boolean,
  isSelectedKey: (round: RoundInfo) => boolean,
  onClick: (r: RoundInfo) => void,
  plantSiteByRound: Map<number, string>,
): React.ReactNode {
  const displayRounds = rounds.filter((r) => !r.is_knife_round);
  const halftimeRoundNumber =
    displayRounds.length >= 12 ? displayRounds[11].round_number : null;
  const pistolRoundNumbers = getPistolRoundNumbers(displayRounds);

  return displayRounds.map((r, idx) => {
    const displayNum = idx + 1;
    const isActive = r.round_number === activeRound && !isHeatmapMode;
    const isHmSel = isHeatmapMode && isSelectedKey(r);

    const otIdx = idx - 24;
    const otPeriod = otIdx >= 0 ? Math.floor(otIdx / 6) + 1 : 0;
    const showHalftime = idx === 12;
    const showOtStart  = idx >= 24 && otIdx % 6 === 0;
    const showOtSwap   = idx >= 27 && (otIdx - 3) % 6 === 0;

    return (
      <React.Fragment key={`${r.demo_id}:${r.round_number}`}>
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
            <span className={styles.halftimeLabel}>
              ot {Math.floor((otIdx - 3) / 6) + 1} · sides swap
            </span>
          </div>
        )}
        <RoundRow
          round={r}
          displayNum={displayNum}
          halftimeRoundNumber={halftimeRoundNumber}
          pistolRoundNumbers={pistolRoundNumbers}
          isActive={isActive}
          isHeatmapSelected={isHmSel}
          plantSite={plantSiteByRound.get(r.round_number)}
          onClick={onClick}
        />
      </React.Fragment>
    );
  });
}

const RoundPanel: React.FC = () => {
  const rounds              = useAppStore((s) => s.rounds);
  const demo                = useAppStore((s) => s.demo);
  const activeRound         = useAppStore((s) => s.activeRound);
  const setActiveRound      = useAppStore((s) => s.setActiveRound);
  const isHeatmapMode       = useAppStore((s) => s.isHeatmapMode);
  const heatmapRounds       = useAppStore((s) => s.selectedRoundsForHeatmap);
  const toggleHeatmapRnd    = useAppStore((s) => s.toggleHeatmapRound);
  const teamSession         = useAppStore((s) => s.teamSession);
  const activeDemoId        = useAppStore((s) => s.activeDemoId);
  const teamHeatmapKeys     = useAppStore((s) => s.teamHeatmapRoundKeys);
  const toggleTeamHmKey     = useAppStore((s) => s.toggleTeamHeatmapRoundKey);
  const maps                = useAppStore((s) => s.maps);
  const events              = useAppStore((s) => s.events);

  const [switching, setSwitching] = useState(false);

  const plantSiteByRound = useMemo(() => {
    const m = new Map<number, string>();
    for (const ev of events) {
      if (ev.event_type === 'bomb_planted' && ev.weapon) {
        m.set(ev.round_number, ev.weapon);
      }
    }
    return m;
  }, [events]);

  // ─── Click handler ──────────────────────────────────────────────────────
  const handleSingleClick = useCallback(
    (round: RoundInfo) => {
      if (isHeatmapMode) {
        toggleHeatmapRnd(round.round_number);
      } else {
        setActiveRound(round.round_number);
      }
    },
    [isHeatmapMode, setActiveRound, toggleHeatmapRnd],
  );

  const handleTeamClick = useCallback(
    async (round: RoundInfo) => {
      const key = `${round.demo_id}:${round.round_number}`;
      if (isHeatmapMode) {
        toggleTeamHmKey(key);
        return;
      }
      // Switch active demo if needed, then jump to the round
      if (round.demo_id !== activeDemoId) {
        setSwitching(true);
        try {
          useAppStore.getState().setActiveDemoId(round.demo_id);
          await loadDemoIntoStore(round.demo_id, { maps, jumpToFirstRound: false });
        } finally {
          setSwitching(false);
        }
      }
      setActiveRound(round.round_number);
    },
    [isHeatmapMode, toggleTeamHmKey, activeDemoId, maps, setActiveRound],
  );

  // ─── Team-mode render ───────────────────────────────────────────────────
  const teamGroups = useMemo(() => {
    if (!teamSession) return [];
    const byDemo = new Map<string, RoundInfo[]>();
    for (const r of teamSession.rounds) {
      if (r.is_knife_round) continue;
      if (!byDemo.has(r.demo_id)) byDemo.set(r.demo_id, []);
      byDemo.get(r.demo_id)!.push(r);
    }
    return teamSession.demo_ids.map((demoId, idx) => {
      const meta = teamSession.demos.find((d) => d.id === demoId);
      const demoRounds = byDemo.get(demoId) ?? [];
      const halftimeRn = demoRounds.length >= 12 ? demoRounds[11].round_number : null;
      return {
        demoId,
        matchNum: idx + 1,
        filename: meta?.filename ?? demoId.slice(0, 8),
        side: teamSession.team_sides[demoId] ?? 'CT',
        rounds: demoRounds,
        halftimeRn,
        pistolRns: getPistolRoundNumbers(demoRounds),
      };
    });
  }, [teamSession]);

  // ─── Render ─────────────────────────────────────────────────────────────
  if (!teamSession && !rounds.length) {
    return (
      <div className={styles.empty}>
        <p>{demo ? 'No rounds found in this demo.' : 'No rounds loaded'}</p>
        {demo && (
          <p className={styles.emptyHint}>Re-upload the demo to retry parsing.</p>
        )}
      </div>
    );
  }

  // Team session mode: render rounds grouped by demo (match)
  if (teamSession) {
    const totalRounds = teamGroups.reduce((sum, g) => sum + g.rounds.length, 0);
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.headerText}>
            {isHeatmapMode ? 'Pick rounds (any match)' : teamSession.name}
          </span>
          <span className={styles.count}>{totalRounds}</span>
        </div>
        <div className={styles.list}>
          {switching && (
            <p className={styles.emptyHint} style={{ padding: '8px 14px' }}>
              Switching demo…
            </p>
          )}
          {teamGroups.map((g) => (
            <div key={g.demoId}>
              <div className={styles.matchHeader}>
                <span className={styles.matchTag}>M{g.matchNum}</span>
                <span className={styles.matchFile} title={g.filename}>{g.filename}</span>
                <span className={g.side === 'CT' ? styles.matchSideCT : styles.matchSideT}>
                  team {g.side}
                </span>
              </div>
              {g.rounds.map((r, idx) => {
                const displayNum = idx + 1;
                const isActiveDemo = g.demoId === activeDemoId;
                const isActive = isActiveDemo && r.round_number === activeRound && !isHeatmapMode;
                const key = `${r.demo_id}:${r.round_number}`;
                const isHmSel = isHeatmapMode && teamHeatmapKeys.includes(key);

                const showHalftime = idx === 12;

                return (
                  <React.Fragment key={key}>
                    {showHalftime && (
                      <div className={styles.halftimeDivider}>
                        <span className={styles.halftimeLabel}>halftime · sides swap</span>
                      </div>
                    )}
                    <RoundRow
                      round={r}
                      displayNum={displayNum}
                      halftimeRoundNumber={g.halftimeRn}
                      pistolRoundNumbers={g.pistolRns}
                      isActive={isActive}
                      isHeatmapSelected={isHmSel}
                      plantSite={plantSiteByRound.get(r.round_number)}
                      onClick={handleTeamClick}
                    />
                  </React.Fragment>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Single-demo mode
  const displayRoundsCount = rounds.filter((r) => !r.is_knife_round).length;
  const isHmSelSingle = (r: RoundInfo) => heatmapRounds.includes(r.round_number);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerText}>
          {isHeatmapMode ? 'Select rounds for heatmap' : 'Rounds'}
        </span>
        <span className={styles.count}>{displayRoundsCount}</span>
      </div>
      <div className={styles.list}>
        {renderSingleDemoRounds(
          rounds, activeRound, isHeatmapMode, isHmSelSingle, handleSingleClick, plantSiteByRound,
        )}
      </div>
    </div>
  );
};

export default RoundPanel;
