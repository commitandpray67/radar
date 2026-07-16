/**
 * TendencyReport — per-player positioning heatmaps split by buy type.
 *
 * One click produces, for every player, heatmap images of how they play the
 * chosen side (CT by default) on Eco/Half rounds, Full-buy rounds, and the
 * rounds where they carried an AWP. Works for a single demo and for a
 * team-analysis session (aggregating across all its demos).
 *
 * Reuses the existing heatmap endpoints — one request per (player, bucket),
 * run with bounded concurrency.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import {
  generateHeatmap, generateTeamHeatmap, getPlayerStateEvents,
} from '../../utils/api';
import { useRoundSides } from '../../hooks/useRoundSides';
import { getTeamRoundsByDemo } from '../../utils/roundUtils';
import {
  buildAwpRounds, buildTendencyBuckets, runLimited,
  type PlayerTendencyBuckets, type ReportPlayer, type TendencyRoundRef,
} from '../../utils/tendencies';
import styles from './TendencyReport.module.css';

interface Props {
  onClose: () => void;
}

type BucketKey = 'ecoHalf' | 'full' | 'awp';
const BUCKETS: { key: BucketKey; label: string }[] = [
  { key: 'ecoHalf', label: 'Eco / Half' },
  { key: 'full', label: 'Full buy' },
  { key: 'awp', label: 'AWP rounds' },
];
const MIN_ROUNDS = 1;
const CONCURRENCY = 3;

interface CellResult {
  image: string | null;   // data-URI PNG (null = failed / no data)
  rounds: number;
}

const TendencyReport: React.FC<Props> = ({ onClose }) => {
  const demo = useAppStore((s) => s.demo);
  const players = useAppStore((s) => s.players);
  const rounds = useAppStore((s) => s.rounds);
  const teamSession = useAppStore((s) => s.teamSession);
  const storeStateEvents = useAppStore((s) => s.playerStateEvents);
  const sideMap = useRoundSides();

  const [side, setSide] = useState<'CT' | 'T'>('CT');
  const [cells, setCells] = useState<Map<string, CellResult>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const runIdRef = useRef(0);

  // ── Report players ────────────────────────────────────────────────────────
  const reportPlayers = useMemo<ReportPlayer[]>(() => {
    if (teamSession) {
      const ids = Array.from(
        new Set([...teamSession.core_roster, ...teamSession.extended_roster]),
      );
      return ids.map((key) => ({
        key,
        num: Number(key),
        name: teamSession.roster_names[key] ?? key,
      }));
    }
    return players.map((p) => ({
      key: p.player_id_str ?? String(p.player_id),
      num: p.player_id,
      dbId: p.id,
      name: p.name,
    }));
  }, [teamSession, players]);

  const roundsByDemo = useMemo(() => {
    if (teamSession) {
      return getTeamRoundsByDemo(teamSession).map((g) => ({
        demoId: g.demoId,
        rounds: g.rounds,
      }));
    }
    return demo ? [{ demoId: demo.id, rounds }] : [];
  }, [teamSession, demo, rounds]);

  const sidesReady = roundsByDemo.length > 0
    && roundsByDemo.every((g) => sideMap[g.demoId]);

  // ── Generate ──────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    if (!sidesReady) return;
    const runId = ++runIdRef.current;
    setError('');
    setCells(new Map());

    try {
      // AWP rounds need state events for every demo in scope. The store only
      // holds the active demo's — fetch the rest (cheap, cached server-side).
      const stateEventsByDemo = await Promise.all(
        roundsByDemo.map(async (g) => ({
          demoId: g.demoId,
          events: !teamSession && demo?.id === g.demoId
            ? storeStateEvents
            : await getPlayerStateEvents(g.demoId),
        })),
      );
      if (runId !== runIdRef.current) return;

      const buckets = buildTendencyBuckets({
        side,
        players: reportPlayers,
        roundsByDemo,
        sideMap,
        awpRounds: buildAwpRounds(stateEventsByDemo),
      });

      // Seed every cell with its round count; queue jobs for non-empty ones.
      const seeded = new Map<string, CellResult>();
      const jobs: (() => Promise<void>)[] = [];
      for (const b of buckets) {
        for (const { key } of BUCKETS) {
          const refs: TendencyRoundRef[] = b[key];
          const cellKey = `${b.player.key}:${key}`;
          seeded.set(cellKey, { image: null, rounds: refs.length });
          if (refs.length < MIN_ROUNDS) continue;
          jobs.push(() => fetchCell(b, key, refs).then((img) => {
            if (runId !== runIdRef.current) return;
            setCells((prev) => {
              const next = new Map(prev);
              next.set(cellKey, { image: img, rounds: refs.length });
              return next;
            });
          }));
        }
      }
      setCells(seeded);
      setProgress({ done: 0, total: jobs.length });

      await runLimited(jobs, CONCURRENCY, () => {
        if (runId === runIdRef.current) {
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        }
      });
    } catch (e) {
      if (runId === runIdRef.current) {
        setError((e as Error)?.message ?? 'Failed to generate the report.');
      }
    } finally {
      if (runId === runIdRef.current) {
        setProgress((p) => (p ? { ...p, done: p.total } : p));
      }
    }

    async function fetchCell(
      b: PlayerTendencyBuckets,
      _bucket: BucketKey,
      refs: TendencyRoundRef[],
    ): Promise<string | null> {
      try {
        if (teamSession) {
          const res = await generateTeamHeatmap(teamSession.id, {
            rounds: refs.map((r) => ({ demo_id: r.demoId, round_number: r.roundNumber })),
            player_ids: [b.player.key],
            exclude_freeze_time: true,
          });
          return res.image;
        }
        if (!demo || b.player.dbId == null) return null;
        const res = await generateHeatmap(demo.id, {
          player_ids: [b.player.dbId],
          round_numbers: refs.map((r) => r.roundNumber),
          exclude_freeze_time: true,
        });
        return res.image;
      } catch {
        return null; // e.g. 404 when the filters match no positions
      }
    }
  }, [sidesReady, side, reportPlayers, roundsByDemo, sideMap, teamSession, demo, storeStateEvents]);

  // Generate on open and whenever the side flips.
  useEffect(() => {
    void generate();
    return () => { runIdRef.current += 1; }; // invalidate in-flight run
  }, [generate]);

  // Players with at least one non-empty bucket float to the top.
  const orderedPlayers = useMemo(() => {
    const total = (key: string) =>
      BUCKETS.reduce((s, b) => s + (cells.get(`${key}:${b.key}`)?.rounds ?? 0), 0);
    return [...reportPlayers].sort((a, b) => total(b.key) - total(a.key));
  }, [reportPlayers, cells]);

  const busy = progress !== null && progress.done < progress.total;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>
            Player tendencies — {side} side
            {teamSession ? ` · ${teamSession.name}` : demo ? ` · ${demo.map_name}` : ''}
          </span>
          <div className={styles.sideToggle}>
            {(['CT', 'T'] as const).map((s) => (
              <button
                key={s}
                className={`${styles.sideBtn} ${side === s ? styles.sideBtnOn : ''}`}
                onClick={() => setSide(s)}
                disabled={busy}
              >
                {s}
              </button>
            ))}
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!sidesReady && <p className={styles.status}>Loading round data…</p>}
        {error && <p className={styles.error}>{error}</p>}
        {busy && progress && (
          <div className={styles.progressWrap}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 100}%` }}
              />
            </div>
            <span className={styles.status}>
              Generating {progress.done}/{progress.total} heatmaps…
            </span>
          </div>
        )}

        <div className={styles.grid}>
          <div className={styles.gridHeader}>
            <span className={styles.playerCol}>Player</span>
            {BUCKETS.map((b) => (
              <span key={b.key} className={styles.bucketCol}>{b.label}</span>
            ))}
          </div>
          {orderedPlayers.map((p) => (
            <div key={p.key} className={styles.row}>
              <span className={styles.playerCol} title={p.name}>{p.name}</span>
              {BUCKETS.map((b) => {
                const cell = cells.get(`${p.key}:${b.key}`);
                const n = cell?.rounds ?? 0;
                return (
                  <div key={b.key} className={styles.cell}>
                    {cell?.image ? (
                      <img
                        className={styles.mapImg}
                        src={cell.image}
                        alt={`${p.name} — ${b.label} (${side})`}
                      />
                    ) : (
                      <div className={styles.placeholder}>
                        {n < MIN_ROUNDS ? 'no rounds' : busy ? '…' : 'no data'}
                      </div>
                    )}
                    <span className={styles.count}>{n} round{n === 1 ? '' : 's'}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default TendencyReport;
