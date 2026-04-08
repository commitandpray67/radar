/**
 * AppLayout — three-column desktop layout:
 *   Left sidebar  : RoundPanel + HeatmapControls tab
 *   Centre        : RadarViewer
 *   Bottom bar    : PlaybackControls
 *   Right sidebar : Player info / selection
 */

import React, { useMemo, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import RadarViewer from '../RadarViewer/RadarViewer';
import RoundPanel from '../RoundPanel/RoundPanel';
import HeatmapControls from '../HeatmapControls/HeatmapControls';
import PlaybackControls from '../Playback/PlaybackControls';
import styles from './AppLayout.module.css';
import { TEAM_COLORS } from '../../types';

type SideTab = 'rounds' | 'heatmap';

const AppLayout: React.FC = () => {
  const demo        = useAppStore((s) => s.demo);
  const players     = useAppStore((s) => s.players);
  const rounds      = useAppStore((s) => s.rounds);
  const positions   = useAppStore((s) => s.positions);
  const activeRound = useAppStore((s) => s.activeRound);

  // Display rounds (knife excluded) for sequential numbering
  const displayRounds = useMemo(
    () => rounds.filter((r) => !r.is_knife_round),
    [rounds],
  );
  const selectedIds = useAppStore((s) => s.selectedPlayerIds);
  const clearSelected = useAppStore((s) => s.clearSelectedPlayers);

  // Build player_id → team_num map from the first position sample in the
  // active round so the right-panel dot reflects the current side, not the
  // initial side (teams swap at halftime).
  const playerTeamMap = useMemo(() => {
    const map = new Map<number, number>();
    for (const pos of positions) {
      if (pos.round_number === activeRound && !map.has(pos.player_id)) {
        map.set(pos.player_id, pos.team_num);
      }
    }
    return map;
  }, [positions, activeRound]);

  const [sideTab, setSideTab] = useState<SideTab>('rounds');

  const roundInfo = rounds.find((r) => r.round_number === activeRound);
  const displayRoundNumber =
    displayRounds.findIndex((r) => r.round_number === activeRound) + 1 || null;

  return (
    <div className={styles.root}>
      {/* ---- Top bar ---- */}
      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <span className={styles.appName}>CS2 Radar</span>
          {demo && (
            <span className={styles.mapBadge}>{demo.map_name}</span>
          )}
        </div>
        <div className={styles.topCenter}>
          {roundInfo && displayRoundNumber && (
            <span className={styles.roundMeta}>
              Round {displayRoundNumber}
              {roundInfo.winner_team && (
                <span
                  className={styles.winnerBadge}
                  style={{
                    color:
                      roundInfo.winner_team === 'CT'
                        ? TEAM_COLORS.CT
                        : TEAM_COLORS.T,
                  }}
                >
                  &nbsp;{roundInfo.winner_team} wins
                </span>
              )}
              &nbsp;·&nbsp;
              <span className={styles.score}>
                CT {roundInfo.ct_score} : {roundInfo.t_score} T
              </span>
            </span>
          )}
        </div>
        <div className={styles.topRight}>
          {demo && (
            <span className={styles.tickRate}>
              {demo.tick_rate.toFixed(0)} tick
            </span>
          )}
        </div>
      </header>

      {/* ---- Main body ---- */}
      <div className={styles.body}>
        {/* Left sidebar */}
        <aside className={styles.sidebar}>
          <div className={styles.tabBar}>
            <button
              className={`${styles.tab} ${sideTab === 'rounds' ? styles.activeTab : ''}`}
              onClick={() => setSideTab('rounds')}
            >
              Rounds
            </button>
            <button
              className={`${styles.tab} ${sideTab === 'heatmap' ? styles.activeTab : ''}`}
              onClick={() => setSideTab('heatmap')}
            >
              Heatmap
            </button>
          </div>
          <div className={styles.sideContent}>
            {sideTab === 'rounds' && <RoundPanel />}
            {sideTab === 'heatmap' && <HeatmapControls />}
          </div>
        </aside>

        {/* Centre: radar + playback */}
        <main className={styles.main}>
          <div className={styles.radarWrapper}>
            <RadarViewer />
          </div>
          <PlaybackControls />
        </main>

        {/* Right panel: player list */}
        <aside className={styles.rightPanel}>
          <div className={styles.rightHeader}>
            <span className={styles.rightTitle}>Players</span>
            {selectedIds.size > 0 && (
              <button className={styles.clearBtn} onClick={clearSelected}>
                Clear
              </button>
            )}
          </div>
          <div className={styles.playerList}>
            {players.map((p, idx) => {
              // Prefer live team_num from position data; fall back to initial_team
              const teamNum = playerTeamMap.get(p.player_id)
                ?? (p.initial_team === 'CT' ? 3 : 2);
              const teamColor = teamNum === 3 ? TEAM_COLORS.CT : TEAM_COLORS.T;
              const teamLabel = teamNum === 3 ? 'CT' : 'T';
              return (
                <div
                  key={p.player_id}
                  className={`${styles.playerRow} ${
                    selectedIds.has(p.player_id) ? styles.playerSelected : ''
                  }`}
                >
                  <span className={styles.playerNum}>{idx + 1}</span>
                  <span
                    className={styles.teamDot}
                    style={{ background: teamColor }}
                  />
                  <span className={styles.playerName}>{p.name}</span>
                  <span className={styles.playerTeam}>{teamLabel}</span>
                </div>
              );
            })}
            {players.length === 0 && (
              <p className={styles.emptyPlayers}>—</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default AppLayout;
