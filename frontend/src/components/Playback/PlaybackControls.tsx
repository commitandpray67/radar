/**
 * PlaybackControls — tick slider, play/pause, speed, and display toggles.
 *
 * In single-round mode: controls currentTick for the active round.
 * In multi-round mode:  controls multiRoundRelativeTick (relative to freeze_end).
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../store/demoStore';
import { tickToTime, ticksPerInterval } from '../../utils/playback';
import styles from './PlaybackControls.module.css';

const PLAYBACK_INTERVAL_MS = 100;
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

const PlaybackControls: React.FC = () => {
  const demo          = useAppStore((s) => s.demo);
  const rounds        = useAppStore((s) => s.rounds);
  const activeRound   = useAppStore((s) => s.activeRound);
  const currentTick   = useAppStore((s) => s.currentTick);
  const isPlaying     = useAppStore((s) => s.isPlaying);
  const speed         = useAppStore((s) => s.speedMultiplier);
  const showDead      = useAppStore((s) => s.showDeadPlayers);
  const showTrails    = useAppStore((s) => s.showTrails);
  const showBomb      = useAppStore((s) => s.showBomb);
  const showGrenades  = useAppStore((s) => s.showGrenades);
  const showYaw       = useAppStore((s) => s.showYaw);

  // Multi-round mode
  const isMultiRoundMode       = useAppStore((s) => s.isMultiRoundMode);
  const multiRoundRelativeTick = useAppStore((s) => s.multiRoundRelativeTick);
  const multiRoundIsPlaying    = useAppStore((s) => s.multiRoundIsPlaying);
  const multiRoundRounds       = useAppStore((s) => s.multiRoundSelectedRounds);

  const setCurrentTick          = useAppStore((s) => s.setCurrentTick);
  const setIsPlaying            = useAppStore((s) => s.setIsPlaying);
  const setSpeedMultiplier      = useAppStore((s) => s.setSpeedMultiplier);
  const setActiveRound          = useAppStore((s) => s.setActiveRound);
  const toggleShowDead          = useAppStore((s) => s.toggleShowDead);
  const toggleShowTrails        = useAppStore((s) => s.toggleShowTrails);
  const toggleShowBomb          = useAppStore((s) => s.toggleShowBomb);
  const toggleShowGrenades      = useAppStore((s) => s.toggleShowGrenades);
  const toggleShowYaw           = useAppStore((s) => s.toggleShowYaw);
  const setMultiRoundRelTick    = useAppStore((s) => s.setMultiRoundRelativeTick);
  const setMultiRoundIsPlaying  = useAppStore((s) => s.setMultiRoundIsPlaying);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Last wall-clock time the tick fired. Used to advance by REAL elapsed time
  // so background-tab throttling (Chrome throttles setInterval to ~1Hz when
  // hidden) doesn't slow playback — we just take bigger steps per tick.
  const lastTickAtRef = useRef<number | null>(null);

  // ---- Single-round mode timing ----
  const roundInfo  = rounds.find((r) => r.round_number === activeRound);
  // Use start_tick (beginning of freeze time) so the slider covers the full round
  // including buy-phase communication.  Multi-round mode is unaffected (uses 0).
  const roundStart = roundInfo?.start_tick ?? 0;
  const roundEnd   = roundInfo?.end_tick ?? 0;

  // Display round number = position among non-knife rounds (1-indexed)
  const displayRounds = rounds.filter((r) => !r.is_knife_round);
  const displayRoundNumber = activeRound !== null
    ? displayRounds.findIndex((r) => r.round_number === activeRound) + 1
    : null;

  // ---- Multi-round mode: max relative tick across selected rounds ----
  const multiMaxRelTick = useMemo(() => {
    if (!isMultiRoundMode || multiRoundRounds.length === 0) return 0;
    return Math.max(
      ...multiRoundRounds.map((rn) => {
        const r = rounds.find((x) => x.round_number === rn);
        return r ? r.end_tick - r.freeze_end_tick : 0;
      }),
    );
  }, [isMultiRoundMode, multiRoundRounds, rounds]);

  // ---- Playback tick function ----
  const tick = useCallback(() => {
    if (!demo) return;
    const now = performance.now();
    const elapsedMs = lastTickAtRef.current === null
      ? PLAYBACK_INTERVAL_MS
      : now - lastTickAtRef.current;
    lastTickAtRef.current = now;
    const advance = ticksPerInterval(demo.tick_rate, speed, elapsedMs);

    if (isMultiRoundMode) {
      const next = Math.min(multiMaxRelTick, useAppStore.getState().multiRoundRelativeTick + advance);
      setMultiRoundRelTick(next);
      // Don't auto-stop; user controls the timeline manually
    } else {
      if (!roundInfo) return;
      const next = Math.min(roundEnd, useAppStore.getState().currentTick + advance);
      setCurrentTick(next);
      if (next >= roundEnd) setIsPlaying(false);
    }
  }, [demo, roundInfo, speed, roundEnd, multiMaxRelTick, isMultiRoundMode,
      setCurrentTick, setIsPlaying, setMultiRoundRelTick]);

  // ---- Interval management ----
  const playing = isMultiRoundMode ? multiRoundIsPlaying : isPlaying;

  useEffect(() => {
    if (playing) {
      lastTickAtRef.current = null;
      intervalRef.current = setInterval(tick, PLAYBACK_INTERVAL_MS);
    } else {
      lastTickAtRef.current = null;
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, tick]);

  // ---- Keyboard shortcuts ----
  // Read all values via getState() so this effect never needs to re-run;
  // no stale closure risk because getState() is always fresh.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const s = useAppStore.getState();
      const activeRoundInfo = s.rounds.find((r) => r.round_number === s.activeRound);
      const rStart = activeRoundInfo?.start_tick ?? 0;
      const rEnd   = activeRoundInfo?.end_tick   ?? 0;
      const maxRelTick = s.isMultiRoundMode
        ? Math.max(0, ...s.multiRoundSelectedRounds.map((rn) => {
            const r = s.rounds.find((x) => x.round_number === rn);
            return r ? r.end_tick - r.freeze_end_tick : 0;
          }))
        : 0;
      const advance = ticksPerInterval(s.demo?.tick_rate ?? 64, s.speedMultiplier, 500);
      if (e.code === 'Space') {
        e.preventDefault();
        if (s.isMultiRoundMode) {
          s.setMultiRoundIsPlaying(!s.multiRoundIsPlaying);
        } else {
          s.setIsPlaying(!s.isPlaying);
        }
      } else if (e.code === 'ArrowRight') {
        if (s.isMultiRoundMode) {
          s.setMultiRoundRelativeTick(Math.min(maxRelTick, s.multiRoundRelativeTick + advance));
        } else {
          s.setCurrentTick(Math.min(rEnd, s.currentTick + advance));
        }
      } else if (e.code === 'ArrowLeft') {
        if (s.isMultiRoundMode) {
          s.setMultiRoundRelativeTick(Math.max(0, s.multiRoundRelativeTick - advance));
        } else {
          s.setCurrentTick(Math.max(rStart, s.currentTick - advance));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const goToPrevRound = () => {
    if (activeRound && activeRound > 1) setActiveRound(activeRound - 1);
  };
  const goToNextRound = () => {
    if (activeRound && activeRound < rounds.length) setActiveRound(activeRound + 1);
  };

  const disabled = !demo || (isMultiRoundMode ? multiRoundRounds.length === 0 : activeRound === null);

  // ---- Time display ----
  const currentTime = isMultiRoundMode
    ? tickToTime(multiRoundRelativeTick, 0, demo?.tick_rate ?? 64)
    : (roundInfo ? tickToTime(currentTick, roundInfo.start_tick, demo?.tick_rate ?? 64) : '0:00');
  const endTime = isMultiRoundMode
    ? tickToTime(multiMaxRelTick, 0, demo?.tick_rate ?? 64)
    : (roundInfo ? tickToTime(roundInfo.end_tick, roundInfo.start_tick, demo?.tick_rate ?? 64) : '0:00');

  const sliderMin   = isMultiRoundMode ? 0 : roundStart;
  const sliderMax   = isMultiRoundMode ? (multiMaxRelTick || 1) : (roundEnd || roundStart + 1);
  const sliderValue = isMultiRoundMode ? multiRoundRelativeTick : currentTick;

  const handleSliderChange = (v: number) => {
    // Scrub without pausing — like YouTube. Playback timer keeps running
    // from the new position.
    if (isMultiRoundMode) {
      setMultiRoundRelTick(v);
    } else {
      setCurrentTick(v);
    }
    // Reset elapsed-time baseline so the next tick doesn't snap forward
    // by the time the user spent dragging.
    lastTickAtRef.current = null;
  };

  const handlePlayPause = () => {
    if (isMultiRoundMode) {
      setMultiRoundIsPlaying(!multiRoundIsPlaying);
    } else {
      setIsPlaying(!isPlaying);
    }
  };

  return (
    <div className={styles.root}>
      {/* Round nav (hidden in multi-round mode) */}
      {!isMultiRoundMode && (
        <div className={styles.roundNav}>
          <button
            className={styles.iconBtn}
            onClick={goToPrevRound}
            disabled={disabled || activeRound === 1}
            title="Previous round"
          >
            ‹
          </button>
          <span className={styles.roundLabel}>
            {displayRoundNumber ? `Round ${displayRoundNumber}` : 'No round'}
          </span>
          <button
            className={styles.iconBtn}
            onClick={goToNextRound}
            disabled={disabled || activeRound === rounds.length}
            title="Next round"
          >
            ›
          </button>
        </div>
      )}

      {/* Multi-round mode label */}
      {isMultiRoundMode && (
        <span className={styles.multiLabel}>Multi-round</span>
      )}

      {/* Play/Pause */}
      <button
        className={styles.playBtn}
        onClick={handlePlayPause}
        disabled={disabled}
        title="Play/Pause (Space)"
      >
        {playing ? '⏸' : '▶'}
      </button>

      {/* Tick slider */}
      <div className={styles.sliderWrapper}>
        <span className={styles.timeLabel}>{currentTime}</span>
        <input
          type="range"
          className={styles.slider}
          min={sliderMin}
          max={sliderMax}
          value={sliderValue}
          disabled={disabled}
          onChange={(e) => handleSliderChange(Number(e.target.value))}
        />
        <span className={styles.timeLabel}>{endTime}</span>
      </div>

      {/* Speed */}
      <div className={styles.speedGroup}>
        {SPEED_OPTIONS.map((s) => (
          <button
            key={s}
            className={`${styles.speedBtn} ${s === speed ? styles.active : ''}`}
            onClick={() => setSpeedMultiplier(s)}
            disabled={disabled}
          >
            {s}×
          </button>
        ))}
      </div>

      {/* Toggles */}
      <div className={styles.toggleGroup}>
        {!isMultiRoundMode && (
          <>
            <button
              className={`${styles.toggleBtn} ${showDead ? styles.on : ''}`}
              onClick={toggleShowDead}
              title="Show/hide dead players"
            >
              💀
            </button>
            <button
              className={`${styles.toggleBtn} ${showTrails ? styles.on : ''}`}
              onClick={toggleShowTrails}
              title="Show/hide movement trails"
            >
              〜
            </button>
            <button
              className={`${styles.toggleBtn} ${showBomb ? styles.on : ''}`}
              onClick={toggleShowBomb}
              title="Show/hide bomb"
            >
              💣
            </button>
          </>
        )}
        <button
          className={`${styles.toggleBtn} ${showGrenades ? styles.on : ''}`}
          onClick={toggleShowGrenades}
          title="Show/hide grenades"
        >
          💥
        </button>
        <button
          className={`${styles.toggleBtn} ${showYaw ? styles.on : ''}`}
          onClick={toggleShowYaw}
          title="Show/hide player view direction"
        >
          ↗
        </button>
      </div>
    </div>
  );
};

export default PlaybackControls;
