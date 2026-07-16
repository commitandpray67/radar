/**
 * StatsPanel — per-demo scoreboard.
 *
 * Fetches the aggregated scoreboard (cached per demo) and renders a sortable
 * table split by side. Metrics that aren't derivable from stored data (ADR,
 * assists) render as "—".
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import { getScoreboard } from '../../utils/api';
import type { ScoreboardRow } from '../../types';
import { TEAM_COLORS } from '../../types';
import styles from './StatsPanel.module.css';

type SortKey = 'kills' | 'deaths' | 'kd' | 'kast' | 'hs_pct' | 'kpr' | 'opening_kills' | 'trade_kills';

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'kills', label: 'K', title: 'Kills' },
  { key: 'deaths', label: 'D', title: 'Deaths' },
  { key: 'kd', label: 'K/D', title: 'Kill/Death ratio' },
  { key: 'kast', label: 'KAST', title: 'Rounds with a Kill, Assist, Survived or Traded (no assist data)' },
  { key: 'hs_pct', label: 'HS%', title: 'Headshot percentage' },
  { key: 'kpr', label: 'KPR', title: 'Kills per round' },
  { key: 'opening_kills', label: 'OK', title: 'Opening kills' },
  { key: 'trade_kills', label: 'TK', title: 'Trade kills' },
];

const StatsPanel: React.FC = () => {
  const demo = useAppStore((s) => s.demo);
  const [rows, setRows] = useState<ScoreboardRow[] | null>(null);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('kills');
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    if (!demo) return;
    let alive = true;
    const controller = new AbortController();
    setRows(null);
    setError('');
    getScoreboard(demo.id, controller.signal)
      .then((sb) => alive && setRows(sb.players))
      .catch((e) => {
        if ((e as { name?: string })?.name === 'CanceledError') return;
        if (alive) setError('Could not load stats for this demo.');
      });
    return () => { alive = false; controller.abort(); };
  }, [demo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSort = (key: SortKey) => {
    if (key === sortKey) setAsc((a) => !a);
    else { setSortKey(key); setAsc(false); }
  };

  const sides = useMemo(() => {
    const rowsBy = (team: 'CT' | 'T') =>
      (rows ?? [])
        .filter((r) => r.initial_team === team)
        .sort((a, b) => {
          const d = (a[sortKey] as number) - (b[sortKey] as number);
          return asc ? d : -d;
        });
    return { CT: rowsBy('CT'), T: rowsBy('T') };
  }, [rows, sortKey, asc]);

  if (!demo) return <div className={styles.empty}>No demo loaded</div>;
  if (error) return <div className={styles.empty}>{error}</div>;
  if (!rows) return <div className={styles.empty}>Loading stats…</div>;

  const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

  const renderSide = (team: 'CT' | 'T', list: ScoreboardRow[]) => (
    <div className={styles.sideBlock}>
      <div
        className={styles.sideHeader}
        style={{ color: team === 'CT' ? TEAM_COLORS.CT : TEAM_COLORS.T }}
      >
        {team}
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.nameCol}>Player</th>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className={`${styles.numCol} ${sortKey === c.key ? styles.sorted : ''}`}
                onClick={() => onSort(c.key)}
                title={c.title}
              >
                {c.label}{sortKey === c.key ? (asc ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.player_id}>
              <td className={styles.nameCol} title={r.name}>{r.name}</td>
              <td className={styles.numCol}>{r.kills}</td>
              <td className={styles.numCol}>{r.deaths}</td>
              <td className={styles.numCol}>{r.kd.toFixed(2)}</td>
              <td className={styles.numCol}>{fmtPct(r.kast)}</td>
              <td className={styles.numCol}>{fmtPct(r.hs_pct)}</td>
              <td className={styles.numCol}>{r.kpr.toFixed(2)}</td>
              <td className={styles.numCol} title={`${r.opening_kills} opening kills, ${r.opening_deaths} opening deaths`}>
                {r.opening_kills}-{r.opening_deaths}
              </td>
              <td className={styles.numCol} title={`${r.trade_kills} trade kills, ${r.traded_deaths} traded deaths`}>
                {r.trade_kills}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className={styles.root}>
      {renderSide('CT', sides.CT)}
      {renderSide('T', sides.T)}
      <p className={styles.note}>
        ADR &amp; assists need damage data the current parse doesn't store, so
        they're omitted. KAST counts Kill / Survived / Traded rounds (no assists).
      </p>
    </div>
  );
};

export default StatsPanel;
