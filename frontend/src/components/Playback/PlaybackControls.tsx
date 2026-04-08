/**
 * PlaybackControls — tick slider, play/pause, speed, and round navigation.
 *
 * The playback engine runs a setInterval that advances currentTick by
 * (tickRate * speed * intervalMs/1000) each frame.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/demoStore';
import { tickToTime, ticksPerInterval } from '../../utils/playback';
import styles from './PlaybackControls.module.css';

const PLAYBACK_INTERVAL_MS = 100;  // update every 100 ms
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

  const setCurrentTick     = useAppStore((s) => s.setCurrentTick);
  const setIsPlaying       = useAppStore((s) => s.setIsPlaying);
  const setSpeedMultiplier = useAppStore((s) => s.setSpeedMultiplier);
  const setActiveRound     = useAppStore((s) => s.setActiveRound);
  const toggleShowDead     = useAppStore((s) => s.toggleShowDead);
  const toggleShowTrails   = useAppStore((s) => s.toggleShowTrails);
  const toggleShowBomb     = useAppStore((s) => s.toggleShowBomb);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Current round info
  const roundInfo = rounds.find((r) => r.round_number === activeRound);
  const roundStart = roundInfo?.freeze_end_tick ?? 0;
  const roundEnd   = roundInfo?.end_tick ?? 0;

  // Advance playback
  const tick = useCallback(() => {
    if (!demo || !roundInfo) return;
    const advance = ticksPerInterval(demo.tick_rate, speed, PLAYBACK_INTERVAL_MS);
    setCurrentTick(
      Math.min(roundEnd, useAppStore.getState().currentTick + advance),
    );
    if (useAppStore.getState().currentTick >= roundEnd) {
      setIsPlaying(false);
    }
  }, [demo, roundInfo, speed, roundEnd, setCurrentTick, setIsPlaying]);

  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(tick, PLAYBACK_INTERVAL_MS);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, tick]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying(!useAppStore.getState().isPlaying);
      } else if (e.code === 'ArrowRight') {
        const advance = ticksPerInterval(demo?.tick_rate ?? 64, speed, 500);
        setCurrentTick(Math.min(roundEnd, useAppStore.getState().currentTick + advance));
      } else if (e.code === 'ArrowLeft') {
        const advance = ticksPerInterval(demo?.tick_rate ?? 64, speed, 500);
        setCurrentTick(Math.max(roundStart, useAppStore.getState().currentTick - advance));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed, roundStart, roundEnd]);

  const goToPrevRound = () => {
    if (activeRound && activeRound > 1) setActiveRound(activeRound - 1);
  };
  const goToNextRound = () => {
    if (activeRound && activeRound < rounds.length) setActiveRound(activeRound + 1);
  };

  const disabled = !demo || activeRound === null;

  const currentTime = roundInfo
    ? tickToTime(currentTick, roundInfo.start_tick, demo?.tick_rate ?? 64)
    : '0:00';
  const endTime = roundInfo
    ? tickToTime(roundInfo.end_tick, roundInfo.start_tick, demo?.tick_rate ?? 64)
    : '0:00';

  return (
    <div className={styles.root}>
      {/* Round nav */}
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

      {/* Play/Pause */}
      <button
        className={styles.playBtn}
        onClick={() => setIsPlaying(!isPlaying)}
        disabled={disabled}
        title="Play/Pause (Space)"
      >
        {isPlaying ? '⏸' : '▶'}
      </button>

      {/* Tick slider */}
      <div className={styles.sliderWrapper}>
        <span className={styles.timeLabel}>{currentTime}</span>
        <input
          type="range"
          className={styles.slider}
          min={roundStart}
          max={roundEnd || roundStart + 1}
          value={currentTick}
          disabled={disabled}
          onChange={(e) => {
            setIsPlaying(false);
            setCurrentTick(Number(e.target.value));
          }}
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
      </div>
    </div>
  );
};

export default PlaybackControls;
