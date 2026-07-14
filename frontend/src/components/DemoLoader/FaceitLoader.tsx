/**
 * FaceitLoader — enter up to 5 FACEIT nicknames, find matches the stack played
 * together (same team), see their map preferences, and load a match's demo
 * straight into the radar via the existing download+parse pipeline.
 *
 * The FACEIT Data API key is entered here (or via the FACEIT_API_KEY env var,
 * which takes precedence) and stored server-side in the app's data folder.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import {
  getFaceitConfig,
  saveFaceitApiKey,
  clearFaceitApiKey,
  resolveFaceitNicknames,
  findFaceitCommonMatches,
  getFaceitStackMapStats,
  getFaceitPlayerMapStats,
  loadFaceitMatch,
  watchParseStatus,
  getMaps,
} from '../../utils/api';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import type {
  FaceitConfig,
  FaceitResolvedPlayer,
  FaceitMatchSummary,
  FaceitStackMapStats,
  FaceitPlayerMapStats,
  ParseJobStatus,
} from '../../types';
import styles from './FaceitLoader.module.css';

const MAX_PLAYERS = 5;

interface Props {
  onComplete: () => void;
  /** Signals the loader to widen once search results are shown. */
  onExpand?: (wide: boolean) => void;
}

function errMsg(e: unknown): string {
  const anyErr = e as { response?: { data?: { detail?: string } }; message?: string };
  return anyErr?.response?.data?.detail ?? anyErr?.message ?? 'Something went wrong.';
}

function isUnconfigured(e: unknown): boolean {
  return (e as { response?: { status?: number } })?.response?.status === 503;
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

const FaceitLoader: React.FC<Props> = ({ onComplete, onExpand }) => {
  const setMaps = useAppStore((s) => s.setMaps);

  // ── API key config ──
  const [config, setConfig] = useState<FaceitConfig | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [keyError, setKeyError] = useState('');

  // ── Finder ──
  const [nicks, setNicks] = useState<string[]>(['', '']);
  const [resolved, setResolved] = useState<FaceitResolvedPlayer[] | null>(null);
  const [matches, setMatches] = useState<FaceitMatchSummary[] | null>(null);
  const [analyzed, setAnalyzed] = useState(0);
  const [mapStats, setMapStats] = useState<FaceitStackMapStats | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [playerMapStats, setPlayerMapStats] = useState<FaceitPlayerMapStats[] | null>(null);
  const [playerMapLoading, setPlayerMapLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  const [loadingMatchId, setLoadingMatchId] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<ParseJobStatus | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let alive = true;
    getFaceitConfig()
      .then((c) => alive && setConfig(c))
      .catch(() => alive && setConfig({ configured: false, source: null }));
    return () => {
      alive = false;
    };
  }, []);

  // Widen the loader card once a search has produced results; reset on unmount.
  useEffect(() => {
    onExpand?.(matches !== null);
    return () => onExpand?.(false);
  }, [matches, onExpand]);

  const isConfigured = !!config?.configured;
  const isEnv = config?.source === 'env';

  const handleSaveKey = useCallback(async () => {
    const key = keyInput.trim();
    if (!key) return;
    setKeyError('');
    setSavingKey(true);
    try {
      const cfg = await saveFaceitApiKey(key);
      setConfig(cfg);
      setEditingKey(false);
      setKeyInput('');
    } catch (e) {
      setKeyError(errMsg(e));
    } finally {
      setSavingKey(false);
    }
  }, [keyInput]);

  const handleClearKey = useCallback(async () => {
    setKeyError('');
    try {
      const cfg = await clearFaceitApiKey();
      setConfig(cfg);
      setEditingKey(false);
      setMatches(null);
      setMapStats(null);
      setPlayerMapStats(null);
      setResolved(null);
    } catch (e) {
      setKeyError(errMsg(e));
    }
  }, []);

  const setNick = (i: number, v: string) =>
    setNicks((prev) => prev.map((n, idx) => (idx === i ? v : n)));
  const addRow = () => setNicks((prev) => (prev.length < MAX_PLAYERS ? [...prev, ''] : prev));
  const removeRow = (i: number) =>
    setNicks((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const resolvedByNick = new Map(
    (resolved ?? []).map((p) => [p.nickname.toLowerCase(), p]),
  );
  const nickById = new Map(
    (resolved ?? [])
      .filter((p) => p.player_id)
      .map((p) => [p.player_id as string, p.nickname]),
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

  const loadPlayerMapStats = useCallback(async (ids: string[]) => {
    setPlayerMapLoading(true);
    setPlayerMapStats(null);
    try {
      setPlayerMapStats((await getFaceitPlayerMapStats(ids)).players);
    } catch {
      /* per-player stats are a nice-to-have; ignore failures */
    } finally {
      setPlayerMapLoading(false);
    }
  }, []);

  const findMatches = useCallback(async () => {
    setError('');
    setMatches(null);
    setMapStats(null);
    setPlayerMapStats(null);
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
      void loadPlayerMapStats(ids);
    } catch (e) {
      setError(errMsg(e));
      if (isUnconfigured(e)) getFaceitConfig().then(setConfig).catch(() => null);
    } finally {
      setSearching(false);
    }
  }, [nicks, loadMapStats, loadPlayerMapStats]);

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
        if (isUnconfigured(e)) getFaceitConfig().then(setConfig).catch(() => null);
      } finally {
        setLoadingMatchId(null);
      }
    },
    [onComplete, setMaps],
  );

  // ── API-key settings block ──
  const showKeyForm = config !== null && (!isConfigured || editingKey);
  const keyBar = (
    <div className={styles.keyBar}>
      {config === null && <span className={styles.subtle}>Checking API key…</span>}

      {config !== null && isConfigured && !editingKey && (
        <div className={styles.keyStatus}>
          <span className={styles.keyOk}>🔑 API key {isEnv ? 'set via environment' : 'saved'}</span>
          {!isEnv && (
            <>
              <button
                className={styles.linkBtn}
                onClick={() => {
                  setEditingKey(true);
                  setKeyInput('');
                }}
              >
                Change
              </button>
              <button className={styles.linkBtn} onClick={handleClearKey}>
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {showKeyForm && (
        <div className={styles.keyForm}>
          <p className={styles.hint}>
            Paste your FACEIT <b>Data API</b> key — free at developers.faceit.com (create
            an app → API Keys → server-side key).
            {isEnv && ' An environment key is already set and takes precedence.'}
          </p>
          <div className={styles.keyInputRow}>
            <input
              type="password"
              className={styles.input}
              placeholder="FACEIT Data API key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveKey();
              }}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className={styles.findBtn}
              onClick={handleSaveKey}
              disabled={savingKey || !keyInput.trim()}
            >
              {savingKey ? 'Saving…' : 'Save key'}
            </button>
          </div>
          {editingKey && isConfigured && (
            <button className={styles.linkBtn} onClick={() => setEditingKey(false)}>
              Cancel
            </button>
          )}
          {keyError && <div className={styles.error}>{keyError}</div>}
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.root}>
      {keyBar}

      {isConfigured && (
        <>
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

          {/* Per-player map stats (lifetime) */}
          {(playerMapLoading || (playerMapStats && playerMapStats.length > 0)) && (
            <div className={styles.mapPanel}>
              <div className={styles.sectionTitle}>
                Player map stats<span className={styles.subtle}> · lifetime, per queried player</span>
              </div>
              {playerMapLoading && <div className={styles.subtle}>Loading player stats…</div>}
              <div className={styles.playerGrid}>
                {playerMapStats?.map((ps) => (
                  <div key={ps.player_id} className={styles.playerCard}>
                    <div className={styles.playerCardName}>
                      {nickById.get(ps.player_id) ?? ps.player_id}
                    </div>
                    {ps.maps.length === 0 ? (
                      <div className={styles.subtle}>No map data</div>
                    ) : (
                      <>
                        <div className={`${styles.psRow} ${styles.psHead}`}>
                          <span className={styles.psMap} />
                          <span className={styles.psNum}>M</span>
                          <span className={styles.psNum}>W%</span>
                          <span className={styles.psNum}>K/D</span>
                        </div>
                        {ps.maps.slice(0, 7).map((m) => (
                          <div key={m.map} className={styles.psRow}>
                            <span className={styles.psMap}>{m.map.replace(/^de_/, '')}</span>
                            <span className={styles.psNum}>{m.matches}</span>
                            <span
                              className={styles.psNum}
                              style={{ color: winRateColor(m.win_rate) }}
                            >
                              {Math.round(m.win_rate * 100)}
                            </span>
                            <span className={styles.psNum}>{m.kd.toFixed(2)}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                ))}
              </div>
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
                      {m.faceit_url && (
                        <a
                          className={styles.matchLink}
                          href={m.faceit_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          FACEIT ↗
                        </a>
                      )}
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
                            style={{
                              width: `${Math.round((loadStatus?.progress ?? 0) * 100)}%`,
                            }}
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
        </>
      )}
    </div>
  );
};

export default FaceitLoader;
