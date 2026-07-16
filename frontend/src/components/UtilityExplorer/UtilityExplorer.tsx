/**
 * UtilityExplorer — filter and statically overlay every grenade on the map.
 *
 * Selecting filters here drives RadarViewer's utility-mode draw branch. Clicking
 * a landing point on the radar jumps playback to that grenade's throw.
 */

import React, { useEffect, useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import { grenadeLineColor } from '../RadarViewer/drawing';
import styles from './UtilityExplorer.module.css';

const TYPE_LABEL: Record<string, string> = {
  smoke: 'Smoke',
  flashbang: 'Flash',
  he: 'HE',
  molotov: 'Molotov',
  incendiary: 'Incendiary',
  decoy: 'Decoy',
};

const UtilityExplorer: React.FC = () => {
  const grenades = useAppStore((s) => s.grenades);
  const players = useAppStore((s) => s.players);
  const rounds = useAppStore((s) => s.rounds);
  const isUtilityMode = useAppStore((s) => s.isUtilityMode);
  const utilityTypes = useAppStore((s) => s.utilityTypes);
  const utilityPlayerIds = useAppStore((s) => s.utilityPlayerIds);
  const utilitySides = useAppStore((s) => s.utilitySides);
  const utilityRoundRange = useAppStore((s) => s.utilityRoundRange);

  const setUtilityMode = useAppStore((s) => s.setUtilityMode);
  const setUtilityTypes = useAppStore((s) => s.setUtilityTypes);
  const setUtilityPlayerIds = useAppStore((s) => s.setUtilityPlayerIds);
  const setUtilitySides = useAppStore((s) => s.setUtilitySides);
  const setUtilityRoundRange = useAppStore((s) => s.setUtilityRoundRange);

  // Enter utility mode while this tab is mounted; leave on unmount.
  useEffect(() => {
    setUtilityMode(true);
    return () => setUtilityMode(false);
  }, [setUtilityMode]);

  const availableTypes = useMemo(
    () => Array.from(new Set(grenades.map((g) => g.grenade_type))).sort(),
    [grenades],
  );
  const throwers = useMemo(() => {
    const ids = new Set(grenades.map((g) => g.thrower_id));
    return players.filter((p) => ids.has(p.player_id));
  }, [grenades, players]);
  const roundNumbers = useMemo(
    () => rounds.filter((r) => !r.is_knife_round).map((r) => r.round_number),
    [rounds],
  );

  const toggleSet = <T,>(set: Set<T>, val: T): Set<T> => {
    const next = new Set(set);
    if (next.has(val)) next.delete(val); else next.add(val);
    return next;
  };

  const matchCount = useMemo(() => {
    // Mirror RadarViewer's filter (minus the side check, which needs round-sides).
    return grenades.filter((g) => {
      if (utilityTypes.size > 0 && !utilityTypes.has(g.grenade_type)) return false;
      if (utilityPlayerIds.size > 0 && !utilityPlayerIds.has(g.thrower_id)) return false;
      if (utilityRoundRange) {
        const [lo, hi] = utilityRoundRange;
        if (g.round_number < lo || g.round_number > hi) return false;
      }
      return true;
    }).length;
  }, [grenades, utilityTypes, utilityPlayerIds, utilityRoundRange]);

  const lo = utilityRoundRange?.[0] ?? roundNumbers[0] ?? 1;
  const hi = utilityRoundRange?.[1] ?? roundNumbers[roundNumbers.length - 1] ?? 1;

  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        {isUtilityMode
          ? 'All matching grenades are drawn on the map. Click a landing point to jump to its throw.'
          : 'Utility overlay is off.'}
        {' '}<b>{matchCount}</b> shown.
      </p>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Type</div>
        <div className={styles.chips}>
          {availableTypes.map((t) => (
            <button
              key={t}
              className={`${styles.chip} ${utilityTypes.has(t) ? styles.chipOn : ''}`}
              style={utilityTypes.has(t) ? { borderColor: grenadeLineColor(t) } : undefined}
              onClick={() => setUtilityTypes(toggleSet(utilityTypes, t))}
            >
              <span className={styles.chipDot} style={{ background: grenadeLineColor(t) }} />
              {TYPE_LABEL[t] ?? t}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Side</div>
        <div className={styles.chips}>
          {(['CT', 'T'] as const).map((s) => (
            <button
              key={s}
              className={`${styles.chip} ${utilitySides.has(s) ? styles.chipOn : ''}`}
              onClick={() => setUtilitySides(toggleSet(utilitySides, s))}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Players</div>
        <div className={styles.chips}>
          {throwers.map((p) => (
            <button
              key={p.player_id}
              className={`${styles.chip} ${utilityPlayerIds.has(p.player_id) ? styles.chipOn : ''}`}
              onClick={() => setUtilityPlayerIds(toggleSet(utilityPlayerIds, p.player_id))}
              title={p.name}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {roundNumbers.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            Rounds {lo}–{hi}
            {utilityRoundRange && (
              <button className={styles.clearBtn} onClick={() => setUtilityRoundRange(null)}>
                all
              </button>
            )}
          </div>
          <div className={styles.rangeRow}>
            <select
              value={lo}
              onChange={(e) => setUtilityRoundRange([Number(e.target.value), Math.max(hi, Number(e.target.value))])}
            >
              {roundNumbers.map((rn, i) => <option key={rn} value={rn}>{i + 1}</option>)}
            </select>
            <span>to</span>
            <select
              value={hi}
              onChange={(e) => setUtilityRoundRange([Math.min(lo, Number(e.target.value)), Number(e.target.value)])}
            >
              {roundNumbers.map((rn, i) => <option key={rn} value={rn}>{i + 1}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  );
};

export default UtilityExplorer;
