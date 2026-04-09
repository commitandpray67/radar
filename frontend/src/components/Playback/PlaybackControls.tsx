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
  const setMultiRoundRelTick    = useAppStore((s) => s.setMultiRoundRelativeTick);
  const setMultiRoundIsPlaying  = useAppStore((s) => s.setMultiRoundIsPlaying);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Single-round mode timing ----
  const roundInfo  = rounds.find((r) => r.round_number === activeRound);
  const roundStart = roundInfo?.freeze_end_tick ?? 0;
  const roundEnd   = roundInfo?.end_tick ?? 0;

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
    const advance = ticksPerInterval(demo.tick_rate, speed, PLAYBACK_INTERVAL_MS);

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
      intervalRef.current = setInterval(tick, PLAYBACK_INTERVAL_MS);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, tick]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const advance = ticksPerInterval(demo?.tick_rate ?? 64, speed, 500);
      if (e.code === 'Space') {
        e.preventDefault();
        if (isMultiRoundMode) {
          setMultiRoundIsPlaying(!useAppStore.getState().multiRoundIsPlaying);
        } else {
          setIsPlaying(!useAppStore.getState().isPlaying);
        }
      } else if (e.code === 'ArrowRight') {
        if (isMultiRoundMode) {
          setMultiRoundRelTick(Math.min(multiMaxRelTick, useAppStore.getState().multiRoundRelativeTick + advance));
        } else {
          setCurrentTick(Math.min(roundEnd, useAppStore.getState().currentTick + advance));
        }
      } else if (e.code === 'ArrowLeft') {
        if (isMultiRoundMode) {
          setMultiRoundRelTick(Math.max(0, useAppStore.getState().multiRoundRelativeTick - advance));
        } else {
          setCurrentTick(Math.max(roundStart, useAppStore.getState().currentTick - advance));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, roundStart, roundEnd, isMultiRoundMode, multiMaxRelTick]);

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
    if (isMultiRoundMode) {
      setMultiRoundIsPlaying(false);
      setMultiRoundRelTick(v);
    } else {
      setIsPlaying(false);
      setCurrentTick(v);
    }
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
            {activeRound !== null ? `Round ${activeRound}` : 'No round'}
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
      </div>
    </div>
  );
};

export default PlaybackControls;
