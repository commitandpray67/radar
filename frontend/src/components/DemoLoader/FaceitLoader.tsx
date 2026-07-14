/**
 * FaceitLoader — enter up to 5 FACEIT nicknames, find matches the stack played
 * together (same team), see their map preferences, and load a match's demo
 * straight into the radar via the existing download+parse pipeline.
 */

import React, { useCallback, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import {
  resolveFaceitNicknames,
  findFaceitCommonMatches,
  getFaceitStackMapStats,
  loadFaceitMatch,
  watchParseStatus,
  getMaps,
} from '../../utils/api';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import type {
  FaceitResolvedPlayer,
  FaceitMatchSummary,
  FaceitStackMapStats,
  ParseJobStatus,
} from '../../types';
import styles from './FaceitLoader.module.css';

const MAX_PLAYERS = 5;

interface Props {
  onComplete: () => void;
}

function errMsg(e: unknown): string {
  const anyErr = e as { response?: { data?: { detail?: string } }; message?: string };
  return anyErr?.response?.data?.detail ?? anyErr?.message ?? 'Something went wrong.';
}

function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function winRateColor(rate: number): string {
  if (rate >= 0.6) return '#3a9a4a';
  if (rate >= 0.5) return '#c8a020';
  return '#c0603a';
}

const FaceitLoader: React.FC<Props> = ({ onComplete }) => {
  const setMaps = useAppStore((s) => s.setMaps);

  const [nicks, setNicks] = useState<string[]>(['', '']);
  const [resolved, setResolved] = useState<FaceitResolvedPlayer[] | null>(null);
  const [matches, setMatches] = useState<FaceitMatchSummary[] | null>(null);
  const [analyzed, setAnalyzed] = useState(0);
  const [mapStats, setMapStats] = useState<FaceitStackMapStats | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  const [loadingMatchId, setLoadingMatchId] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<ParseJobStatus | null>(null);
  const [loadError, setLoadError] = useState('');

  const setNick = (i: number, v: string) =>
    setNicks((prev) => prev.map((n, idx) => (idx === i ? v : n)));
  const addRow = () => setNicks((prev) => (prev.length < MAX_PLAYERS ? [...prev, ''] : prev));
  const removeRow = (i: number) =>
    setNicks((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const resolvedByNick = new Map(
    (resolved ?? []).map((p) => [p.nickname.toLowerCase(), p]),
  );

  const loadMapStats = useCallback(async (ids: string[]) => {
    setMapLoading(true);
    setMapStats(null);
    try {
      setMapStats(await getFaceitStackMapStats(ids));
    } catch {
      /* map profile is a nice-to-have; ignore failures */
    } finally {
      setMapLoading(false);
    }
  }, []);

  const findMatches = useCallback(async () => {
    setError('');
    setMatches(null);
    setMapStats(null);
    setSearching(true);
    try {
      const wanted = nicks.map((n) => n.trim()).filter(Boolean);
      if (wanted.length === 0) {
        setError('Enter at least one nickname.');
        return;
      }
      const { players } = await resolveFaceitNicknames(wanted);
      setResolved(players);
      const ids = players.filter((p) => p.found && p.player_id).map((p) => p.player_id as string);
      if (ids.length === 0) {
        setError('None of those nicknames have a CS2 profile.');
        return;
      }
      const cm = await findFaceitCommonMatches(ids);
      setMatches(cm.matches);
      setAnalyzed(cm.analyzed);
      void loadMapStats(ids);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSearching(false);
    }
  }, [nicks, loadMapStats]);

  const loadInRadar = useCallback(
    async (matchId: string) => {
      setLoadError('');
      setLoadStatus(null);
      setLoadingMatchId(matchId);
      try {
        const { job_id, demo_id, cached } = await loadFaceitMatch(matchId);
        if (!cached) {
          await watchParseStatus(job_id, setLoadStatus);
        }
        const maps = await getMaps();
        setMaps(maps);
        await loadDemoIntoStore(demo_id, { maps });
        onComplete();
      } catch (e) {
        setLoadError(errMsg(e));
      } finally {
        setLoadingMatchId(null);
      }
    },
    [onComplete, setMaps],
  );

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        Enter up to {MAX_PLAYERS} FACEIT nicknames to find matches the stack played
        together (same team), then load one into the radar.
      </p>

      {/* Nickname inputs */}
      <div className={styles.inputs}>
        {nicks.map((n, i) => {
          const r = n.trim() ? resolvedByNick.get(n.trim().toLowerCase()) : undefined;
          return (
            <div key={i} className={styles.inputRow}>
              <input
                className={styles.input}
                placeholder={`Nickname ${i + 1}`}
                value={n}
                onChange={(e) => setNick(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') findMatches();
                }}
                spellCheck={false}
              />
              {r && (
                <span
                  className={`${styles.badge} ${r.found ? styles.badgeOk : styles.badgeBad}`}
                  title={r.error ?? r.nickname}
                >
                  {r.found ? `✓ lvl ${r.skill_level ?? '?'}` : `✕ ${r.error ?? 'not found'}`}
                </span>
              )}
              {nicks.length > 1 && (
                <button
                  className={styles.removeBtn}
                  onClick={() => removeRow(i)}
                  title="Remove"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.actions}>
        {nicks.length < MAX_PLAYERS && (
          <button className={styles.addBtn} onClick={addRow}>
            + Add player
          </button>
        )}
        <button className={styles.findBtn} onClick={findMatches} disabled={searching}>
          {searching ? 'Searching…' : 'Find matches'}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {loadError && <div className={styles.error}>{loadError}</div>}

      {/* Map preference profile */}
      {(mapLoading || (mapStats && mapStats.maps.length > 0)) && (
        <div className={styles.mapPanel}>
          <div className={styles.sectionTitle}>
            Map preferences
            {mapStats && (
              <span className={styles.subtle}>
                {' '}· {mapStats.analyzed} of {mapStats.total_matches} analysed
              </span>
            )}
          </div>
          {mapLoading && <div className={styles.subtle}>Analysing maps…</div>}
          {mapStats?.maps.map((m) => (
            <div key={m.map} className={styles.mapRow}>
              <span className={styles.mapName}>{m.map.replace(/^de_/, '')}</span>
              <div className={styles.prefBarWrap}>
                <div
                  className={styles.prefBar}
                  style={{ width: `${Math.round(m.preference_pct * 100)}%` }}
                />
              </div>
              <span className={styles.mapCount}>{m.played}×</span>
              <span className={styles.winRate} style={{ color: winRateColor(m.win_rate) }}>
                {Math.round(m.win_rate * 100)}% W
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Matches list */}
      {matches && (
        <div className={styles.matches}>
          <div className={styles.sectionTitle}>
            {matches.length > 0
              ? `${matches.length} match${matches.length === 1 ? '' : 'es'} together`
              : 'No matches found'}
            <span className={styles.subtle}> · scanned {analyzed} recent games</span>
          </div>
          {matches.length === 0 && (
            <div className={styles.subtle}>
              Try more players or a longer history window — the search scans each
              player's most recent games.
            </div>
          )}
          {matches.map((m) => {
            const busy = loadingMatchId === m.match_id;
            return (
              <div key={m.match_id} className={styles.matchRow}>
                <div className={styles.matchMeta}>
                  <span className={styles.matchDate}>{fmtDate(m.started_at)}</span>
                  <span className={styles.matchComp} title={m.competition_type}>
                    {m.competition_name || m.competition_type || 'Match'}
                  </span>
                  {m.region && <span className={styles.subtle}>{m.region}</span>}
                  {m.score && <span className={styles.matchScore}>{m.score}</span>}
                </div>
                <div className={styles.matchPlayers}>
                  {m.selected_players.map((p) => (
                    <span
                      key={p.player_id}
                      className={`${styles.playerTag} ${
                        p.faction === 'faction1' ? styles.fac1 : styles.fac2
                      }`}
                    >
                      {p.nickname}
                    </span>
                  ))}
                </div>
                {busy ? (
                  <div className={styles.loadProgress}>
                    <div className={styles.progressText}>
                      {loadStatus?.message ?? 'Downloading demo…'}
                    </div>
                    <div className={styles.progressTrack}>
                      <div
                        className={styles.progressFill}
                        style={{ width: `${Math.round((loadStatus?.progress ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    className={styles.loadBtn}
                    onClick={() => loadInRadar(m.match_id)}
                    disabled={loadingMatchId !== null}
                  >
                    Load in radar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default FaceitLoader;
