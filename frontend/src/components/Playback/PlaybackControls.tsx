/**
 * PlaybackControls — tick slider, play/pause, speed, and display toggles.
 *
 * In single-round mode: controls currentTick for the active round.
 * In multi-round mode:  controls multiRoundRelativeTick (relative to freeze_end).
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../store/demoStore';
import { tickToTime, ticksPerInterval } from '../../utils/playback';
import TimelineMarkers from './TimelineMarkers';
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
  const extendedPlayback   = useAppStore((s) => s.extendedPlayback);
  const continuousPlayback = useAppStore((s) => s.continuousPlayback);
  const events        = useAppStore((s) => s.events);
  const players       = useAppStore((s) => s.players);
  const teamByPlayer  = useAppStore((s) => s.teamByPlayer);

  // Multi-round mode
  const isMultiRoundMode       = useAppStore((s) => s.isMultiRoundMode);
  const multiRoundRelativeTick = useAppStore((s) => s.multiRoundRelativeTick);
  const multiRoundIsPlaying    = useAppStore((s) => s.multiRoundIsPlaying);
  const multiRoundRounds       = useAppStore((s) => s.multiRoundSelectedRounds);
  const multiRoundTeamKeys     = useAppStore((s) => s.multiRoundTeamKeys);
  const teamSession            = useAppStore((s) => s.teamSession);

  const setCurrentTick          = useAppStore((s) => s.setCurrentTick);
  const setIsPlaying            = useAppStore((s) => s.setIsPlaying);
  const setSpeedMultiplier      = useAppStore((s) => s.setSpeedMultiplier);
  const setActiveRound          = useAppStore((s) => s.setActiveRound);
  const toggleShowDead          = useAppStore((s) => s.toggleShowDead);
  const toggleShowTrails        = useAppStore((s) => s.toggleShowTrails);
  const toggleShowBomb          = useAppStore((s) => s.toggleShowBomb);
  const toggleShowGrenades      = useAppStore((s) => s.toggleShowGrenades);
  const toggleShowYaw           = useAppStore((s) => s.toggleShowYaw);
  const toggleExtendedPlayback  = useAppStore((s) => s.toggleExtendedPlayback);
  const toggleContinuousPlayback = useAppStore((s) => s.toggleContinuousPlayback);
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
  const tickRate   = demo?.tick_rate ?? 64;

  // ---- Extended playback window (single-round only) ----
  // When enabled, playback runs past round end through the post-round restart
  // delay — up to the next round's freeze start (where that round begins), or
  // a fixed buffer past end for the final round.  Lets the user hear voice
  // comms that happen after the round is decided.
  const effectiveEnd = useMemo(() => {
    if (!extendedPlayback || isMultiRoundMode || !roundInfo) return roundEnd;
    const idx = rounds.findIndex((r) => r.round_number === activeRound);
    const next = idx >= 0 ? rounds[idx + 1] : undefined;
    if (next && next.start_tick > roundEnd) return next.start_tick;
    return roundEnd + Math.round(tickRate * 12);
  }, [extendedPlayback, isMultiRoundMode, roundInfo, rounds, activeRound, roundEnd, tickRate]);

  // Advance to the next round and keep playing (continuous playback).
  // Returns false when there is no next round (playback should then stop).
  const advanceToNextRoundContinuous = useCallback((): boolean => {
    const s = useAppStore.getState();
    const idx = s.rounds.findIndex((r) => r.round_number === s.activeRound);
    const next = idx >= 0 ? s.rounds[idx + 1] : undefined;
    if (!next) return false;
    // setActiveRound resets currentTick to the round start and pauses; resume
    // immediately so playback flows seamlessly into the next round.
    s.setActiveRound(next.round_number);
    s.setIsPlaying(true);
    lastTickAtRef.current = null;
    return true;
  }, []);

  // Display round number = position among non-knife rounds (1-indexed)
  const displayRounds = rounds.filter((r) => !r.is_knife_round);
  const displayRoundNumber = activeRound !== null
    ? displayRounds.findIndex((r) => r.round_number === activeRound) + 1
    : null;

  // ---- Multi-round mode: max relative tick across selected rounds ----
  const multiMaxRelTick = useMemo(() => {
    if (!isMultiRoundMode) return 0;
    if (teamSession) {
      if (multiRoundTeamKeys.length === 0) return 0;
      return Math.max(
        ...multiRoundTeamKeys.map((k) => {
          const sep = k.indexOf(':');
          const dId = k.slice(0, sep);
          const rn  = parseInt(k.slice(sep + 1), 10);
          const r = teamSession.rounds.find(
            (x) => x.demo_id === dId && x.round_number === rn,
          );
          return r ? r.end_tick - r.freeze_end_tick : 0;
        }),
      );
    }
    if (multiRoundRounds.length === 0) return 0;
    return Math.max(
      ...multiRoundRounds.map((rn) => {
        const r = rounds.find((x) => x.round_number === rn);
        return r ? r.end_tick - r.freeze_end_tick : 0;
      }),
    );
  }, [isMultiRoundMode, teamSession, multiRoundTeamKeys, multiRoundRounds, rounds]);

  // ---- Event markers for scrubber ----
  const MARKER_TYPES = new Set(['player_death', 'bomb_planted', 'bomb_defused', 'bomb_exploded']);
  const activeRoundEvents = useMemo(() => {
    if (isMultiRoundMode || activeRound === null || !roundInfo) return [];
    const span = effectiveEnd - roundStart;
    if (span <= 0) return [];
    return events
      .filter((e) => e.round_number === activeRound && MARKER_TYPES.has(e.event_type))
      .map((e) => ({ ...e, pct: ((e.tick - roundStart) / span) * 100 }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, activeRound, roundStart, effectiveEnd, isMultiRoundMode, roundInfo]);

  const playersById = useMemo(
    () => new Map(players.map((p) => [p.player_id, p.name])),
    [players],
  );

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
      const next = Math.min(effectiveEnd, useAppStore.getState().currentTick + advance);
      setCurrentTick(next);
      if (next >= effectiveEnd) {
        // At the end of the (possibly extended) window: either roll into the
        // next round or stop.  Continuous playback only applies when extended.
        if (extendedPlayback && continuousPlayback) {
          if (!advanceToNextRoundContinuous()) setIsPlaying(false);
        } else {
          setIsPlaying(false);
        }
      }
    }
  }, [demo, roundInfo, speed, effectiveEnd, multiMaxRelTick, isMultiRoundMode,
      extendedPlayback, continuousPlayback, advanceToNextRoundContinuous,
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
      // Extended playback stretches the right edge into the post-round window.
      let rEffEnd = rEnd;
      if (s.extendedPlayback && !s.isMultiRoundMode && activeRoundInfo) {
        const idx = s.rounds.findIndex((r) => r.round_number === s.activeRound);
        const nxt = idx >= 0 ? s.rounds[idx + 1] : undefined;
        rEffEnd = (nxt && nxt.start_tick > rEnd)
          ? nxt.start_tick
          : rEnd + Math.round((s.demo?.tick_rate ?? 64) * 12);
      }
      const maxRelTick = s.isMultiRoundMode
        ? (s.teamSession
            ? Math.max(0, ...s.multiRoundTeamKeys.map((k) => {
                const sep = k.indexOf(':');
                const dId = k.slice(0, sep);
                const rn  = parseInt(k.slice(sep + 1), 10);
                const r = s.teamSession!.rounds.find(
                  (x) => x.demo_id === dId && x.round_number === rn,
                );
                return r ? r.end_tick - r.freeze_end_tick : 0;
              }))
            : Math.max(0, ...s.multiRoundSelectedRounds.map((rn) => {
                const r = s.rounds.find((x) => x.round_number === rn);
                return r ? r.end_tick - r.freeze_end_tick : 0;
              })))
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
          s.setCurrentTick(Math.min(rEffEnd, s.currentTick + advance));
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

  // Navigate by position in the rounds array — round_number is not guaranteed
  // to be a contiguous 1..N (knife rounds, round 0, overtime).
  const roundIdx = rounds.findIndex((r) => r.round_number === activeRound);
  const goToPrevRound = () => {
    if (roundIdx > 0) setActiveRound(rounds[roundIdx - 1].round_number);
  };
  const goToNextRound = () => {
    if (roundIdx >= 0 && roundIdx < rounds.length - 1) {
      setActiveRound(rounds[roundIdx + 1].round_number);
    }
  };

  const disabled = !demo || (isMultiRoundMode
    ? (teamSession ? multiRoundTeamKeys.length === 0 : multiRoundRounds.length === 0)
    : activeRound === null);

  // ---- Time display ----
  const currentTime = isMultiRoundMode
    ? tickToTime(multiRoundRelativeTick, 0, demo?.tick_rate ?? 64)
    : (roundInfo ? tickToTime(currentTick, roundInfo.start_tick, demo?.tick_rate ?? 64) : '0:00');
  const endTime = isMultiRoundMode
    ? tickToTime(multiMaxRelTick, 0, demo?.tick_rate ?? 64)
    : (roundInfo ? tickToTime(effectiveEnd, roundInfo.start_tick, demo?.tick_rate ?? 64) : '0:00');

  const sliderMin   = isMultiRoundMode ? 0 : roundStart;
  const sliderMax   = isMultiRoundMode ? (multiMaxRelTick || 1) : (effectiveEnd || roundStart + 1);
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
            disabled={disabled || roundIdx <= 0}
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
            disabled={disabled || roundIdx === rounds.length - 1}
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
        <div className={styles.sliderTrack}>
          <input
            type="range"
            className={styles.slider}
            min={sliderMin}
            max={sliderMax}
            value={sliderValue}
            disabled={disabled}
            onChange={(e) => handleSliderChange(Number(e.target.value))}
          />
          <TimelineMarkers
            events={activeRoundEvents}
            playersById={playersById}
            teamByPlayer={teamByPlayer}
            onSeek={setCurrentTick}
          />
        </div>
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
            <button
              className={`${styles.toggleBtn} ${extendedPlayback ? styles.on : ''}`}
              onClick={toggleExtendedPlayback}
              title="Extended playback — include freeze time + post-round restart delay (hear all voice comms)"
            >
              ⏱
            </button>
            {extendedPlayback && (
              <button
                className={`${styles.toggleBtn} ${continuousPlayback ? styles.on : ''}`}
                onClick={toggleContinuousPlayback}
                title="Continuous playback — auto-advance to the next round"
              >
                ⏭
              </button>
            )}
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
