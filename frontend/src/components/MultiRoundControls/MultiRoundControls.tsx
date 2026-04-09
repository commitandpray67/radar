/**
 * MultiRoundControls — panel for selecting players + rounds for the
 * multi-round overlay replay mode.
 *
 * When active, all selected rounds play simultaneously on the same map,
 * synced from their individual freeze_end_tick (round-relative time = 0).
 * All player dots are rendered in a neutral colour regardless of team.
 */

import React, { useCallback, useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import styles from './MultiRoundControls.module.css';

// Collapse consecutive round numbers into ranges, e.g. [2,3,4,7] → "2–4, 7"
function toRangeString(nums: number[]): string {
  if (nums.length === 0) return '';
  const s = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let lo = s[0], hi = s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i] === hi + 1) { hi = s[i]; }
    else {
      parts.push(lo === hi ? `${lo}` : `${lo}–${hi}`);
      lo = hi = s[i];
    }
  }
  parts.push(lo === hi ? `${lo}` : `${lo}–${hi}`);
  return parts.join(', ');
}

const MultiRoundControls: React.FC = () => {
  const rounds         = useAppStore((s) => s.rounds);
  const players        = useAppStore((s) => s.players);
  const isActive       = useAppStore((s) => s.isMultiRoundMode);
  const selRounds      = useAppStore((s) => s.multiRoundSelectedRounds);
  const selPlayers     = useAppStore((s) => s.multiRoundSelectedPlayers);

  const setMode            = useAppStore((s) => s.setMultiRoundMode);
  const toggleRound        = useAppStore((s) => s.toggleMultiRoundRound);
  const setRounds          = useAppStore((s) => s.setMultiRoundRounds);
  const togglePlayer       = useAppStore((s) => s.toggleMultiRoundPlayer);
  const setPlayers_        = useAppStore((s) => s.setMultiRoundPlayers);

  const nonKnifeRounds = useMemo(
    () => rounds.filter((r) => !r.is_knife_round),
    [rounds],
  );

  const halftimeBoundary = useMemo(
    () => (nonKnifeRounds.length > 12 ? nonKnifeRounds[11].round_number : Infinity),
    [nonKnifeRounds],
  );

  const allRoundNums   = useMemo(() => nonKnifeRounds.map((r) => r.round_number), [nonKnifeRounds]);
  const firstHalfNums  = useMemo(
    () => nonKnifeRounds.filter((r) => r.round_number <= halftimeBoundary).map((r) => r.round_number),
    [nonKnifeRounds, halftimeBoundary],
  );
  const secondHalfNums = useMemo(
    () => nonKnifeRounds.filter((r) => r.round_number > halftimeBoundary).map((r) => r.round_number),
    [nonKnifeRounds, halftimeBoundary],
  );

  const canActivate = selRounds.length >= 2;

  const handleActivate = useCallback(() => {
    if (!canActivate) return;
    setMode(true);
  }, [canActivate, setMode]);

  const handleDeactivate = useCallback(() => {
    setMode(false);
  }, [setMode]);

  return (
    <div className={styles.root}>
      {/* ── Mode status ──────────────────────────────────────────── */}
      <div className={styles.modeRow}>
        <span className={styles.modeLabel}>Multi-round replay</span>
        <span className={`${styles.statusBadge} ${isActive ? styles.statusOn : ''}`}>
          {isActive ? 'ACTIVE' : 'OFF'}
        </span>
      </div>

      <p className={styles.hint}>
        Select 2+ rounds and players, then activate to replay them overlaid on the same map.
      </p>

      {/* ── Players ──────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span>Players</span>
          <div className={styles.headerActions}>
            <button
              className={styles.smallBtn}
              onClick={() => setPlayers_(players.map((p) => p.player_id))}
            >
              All
            </button>
            {selPlayers.size > 0 && (
              <button className={styles.smallBtn} onClick={() => setPlayers_([])}>
                Clear
              </button>
            )}
          </div>
        </div>
        <div className={styles.playerList}>
          {players.map((p, idx) => {
            const isSel = selPlayers.has(p.player_id);
            const isCT  = p.initial_team === 'CT';
            return (
              <button
                key={p.player_id}
                className={[
                  styles.playerChip,
                  isSel ? styles.selected : '',
                  isCT  ? styles.ct : styles.t,
                ].join(' ')}
                onClick={() => togglePlayer(p.player_id)}
                title={isSel ? `Deselect ${p.name}` : `Select ${p.name}`}
              >
                <span className={styles.playerNum}>{idx + 1}</span>
                <span className={styles.playerName}>{p.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Rounds ───────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span>Rounds</span>
          {selRounds.length > 0 && (
            <span className={styles.pill}>{selRounds.length} selected</span>
          )}
        </div>

        <div className={styles.quickSelectRow}>
          <button className={styles.quickBtn} onClick={() => setRounds(allRoundNums)}>
            All
          </button>
          <button
            className={styles.quickBtn}
            onClick={() => setRounds(firstHalfNums)}
            disabled={firstHalfNums.length === 0}
            title="Rounds 1–12"
          >
            1st half
          </button>
          <button
            className={styles.quickBtn}
            onClick={() => setRounds(secondHalfNums)}
            disabled={secondHalfNums.length === 0}
            title="Rounds 13+"
          >
            2nd half
          </button>
          <button
            className={`${styles.quickBtn} ${styles.quickBtnClear}`}
            onClick={() => setRounds([])}
            disabled={selRounds.length === 0}
          >
            Clear
          </button>
        </div>

        {/* Individual round toggles */}
        <div className={styles.roundGrid}>
          {nonKnifeRounds.map((r, idx) => {
            const displayNum = idx + 1;
            const isSel = selRounds.includes(r.round_number);
            const isHalf2Start = r.round_number === halftimeBoundary + 1;
            return (
              <React.Fragment key={r.round_number}>
                {isHalf2Start && <div className={styles.halfDivider} />}
                <button
                  className={`${styles.roundBtn} ${isSel ? styles.roundBtnSel : ''}`}
                  onClick={() => toggleRound(r.round_number)}
                  title={`Round ${displayNum}`}
                >
                  {displayNum}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {selRounds.length > 0 && (
          <p className={styles.roundsSummary}>{toRangeString(selRounds)}</p>
        )}
      </div>

      {/* ── Activate / Deactivate ────────────────────────────────── */}
      <div className={styles.actionRow}>
        {!isActive ? (
          <button
            className={styles.activateBtn}
            onClick={handleActivate}
            disabled={!canActivate}
            title={canActivate ? undefined : 'Select at least 2 rounds'}
          >
            Activate overlay
          </button>
        ) : (
          <button className={styles.deactivateBtn} onClick={handleDeactivate}>
            Exit overlay
          </button>
        )}
      </div>
    </div>
  );
};

export default MultiRoundControls;
