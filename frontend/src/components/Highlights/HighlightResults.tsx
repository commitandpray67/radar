/**
 * HighlightResults — the list of a player's multi-kill rounds across demos.
 *
 * Shared by the loader's Highlights tab and the in-app sidebar. Clicking a
 * highlight loads its demo (if needed) and seeks to just before the first kill.
 */

import React, { useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import type { Highlight, HighlightDemoResult, HighlightSearchResult } from '../../types';
import { countByTier, killLabel, openHighlight, weaponLabel } from '../../utils/highlights';
import { TEAM_COLORS } from '../../types';
import styles from './Highlights.module.css';

interface Props {
  result: HighlightSearchResult;
  /** Called after a highlight has been opened (e.g. to close the loader). */
  onOpened?: () => void;
  compact?: boolean;
}

const HighlightResults: React.FC<Props> = ({ result, onOpened, compact = false }) => {
  const activeDemoId = useAppStore((s) => s.demo?.id);
  const activeRound = useAppStore((s) => s.activeRound);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const tiers = countByTier(result);
  const weaponText = result.weapons.length
    ? result.weapons.map(weaponLabel).join(' / ')
    : 'any weapon';
  const withPlayer = result.demos.filter((d) => (d.matched_players ?? []).length > 0);
  const missing = result.demos.filter((d) => !d.error && (d.matched_players ?? []).length === 0);
  const failed = result.demos.filter((d) => d.error);

  const open = async (d: HighlightDemoResult, h: Highlight) => {
    const key = `${d.demo_id}:${h.round_number}`;
    setOpeningKey(key);
    setError('');
    try {
      await openHighlight(
        d.demo_id,
        h,
        (d.matched_players ?? []).map((p) => p.player_id),
      );
      onOpened?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open highlight');
    } finally {
      setOpeningKey(null);
    }
  };

  return (
    <div className={styles.results}>
      <div className={styles.summary}>
        <span>
          <strong>{result.total}</strong> highlight{result.total !== 1 ? 's' : ''} for{' '}
          <strong>{result.player}</strong> — {killLabel(result.min_kills)}
          {result.min_kills < 5 ? '+' : ''} with {weaponText}
        </span>
        {result.total > 0 && (
          <span className={styles.tierCounts}>
            {Object.entries(tiers)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, n]) => `${n}× ${k}`)
              .join(' · ')}
          </span>
        )}
        <span className={styles.summarySub}>
          Found in {withPlayer.length}/{result.demos.length} demo
          {result.demos.length !== 1 ? 's' : ''}
        </span>
      </div>

      {withPlayer.map((d) => d.highlights.length > 0 && (
        <div key={d.demo_id} className={styles.demoGroup}>
          <div className={styles.demoHeader} title={d.filename}>
            <span className={styles.demoFile}>{d.filename}</span>
            <span className={styles.demoMap}>{d.map_name}</span>
          </div>
          {d.highlights.map((h) => {
            const key = `${d.demo_id}:${h.round_number}`;
            const isActive = d.demo_id === activeDemoId && h.round_number === activeRound;
            return (
              <button
                key={key}
                className={`${styles.hlRow} ${isActive ? styles.hlActive : ''}`}
                onClick={() => open(d, h)}
                disabled={openingKey !== null}
                title={h.kill_list
                  .map((k) => `${k.victim_name || k.victim_id} (${weaponLabel(k.weapon)}${k.headshot ? ', HS' : ''})`)
                  .join('\n')}
              >
                <span className={`${styles.tier} ${h.kills >= 5 ? styles.tierAce : h.kills === 4 ? styles.tier4 : ''}`}>
                  {killLabel(h.kills)}
                </span>
                <span className={styles.hlRound}>R{h.round_number}</span>
                {h.side && (
                  <span
                    className={styles.hlSide}
                    style={{ color: h.side === 'CT' ? TEAM_COLORS.CT : TEAM_COLORS.T }}
                  >
                    {h.side}
                  </span>
                )}
                <span className={styles.hlMeta}>
                  {h.kill_list.filter((k) => k.headshot).length} HS · {h.duration_s.toFixed(1)}s
                  {h.round_kills > h.kills ? ` · ${h.round_kills}K total` : ''}
                </span>
                {h.round_won !== null && (
                  <span className={h.round_won ? styles.won : styles.lost}>
                    {h.round_won ? 'W' : 'L'}
                  </span>
                )}
                <span className={styles.hlGo}>
                  {openingKey === key ? '…' : '▶'}
                </span>
              </button>
            );
          })}
        </div>
      ))}

      {result.total === 0 && withPlayer.length > 0 && (
        <p className={styles.empty}>No matching rounds in these demos.</p>
      )}
      {missing.length > 0 && (
        <p className={styles.note}>
          “{result.player}” isn’t in {missing.length} demo{missing.length !== 1 ? 's' : ''}
          {!compact && `: ${missing.map((d) => d.filename).join(', ')}`}. Names must match
          exactly (case-insensitive) — or search by SteamID64.
        </p>
      )}
      {failed.length > 0 && (
        <p className={styles.note}>{failed.length} demo(s) could not be searched.</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
};

export default HighlightResults;
