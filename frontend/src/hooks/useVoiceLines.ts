/**
 * useVoiceLines — synchronises CS2 demo voice audio with single-round playback.
 *
 * Behaviour
 * ---------
 * - Voice data is fetched lazily when a round is selected (not on demo upload).
 * - Only active in single-round mode (noop in multi-round or heatmap mode).
 * - Each player's audio is split into clips (OGG Opus).  Each clip is decoded
 *   into an AudioBuffer and scheduled via the Web Audio API.
 * - When isPlaying → true  : all unmuted clips are scheduled from currentTick.
 *   Clips that already ended are skipped; clips that started before currentTick
 *   are started at an offset; future clips are scheduled with a ctx-time delay.
 * - When isPlaying → false : all scheduled sources are stopped.
 * - Seek (currentTick jumps > 64 ticks while playing) : reschedule everything.
 * - Mute toggles take effect at the next play/seek.
 *
 * No native libraries are required on the server — OGG Opus files are decoded
 * natively by the browser's Web Audio API.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAppStore } from '../store/demoStore';
import { getVoiceManifest } from '../utils/api';

// ── Types ──────────────────────────────────────────────────────────────────

interface LoadedClip {
  startTick: number;
  buffer: AudioBuffer;
}

interface LoadedPlayer {
  steamid: number;
  clips: LoadedClip[];
}

/** Lightweight clip metadata (no AudioBuffer) used for reactive speaking detection. */
interface ClipMeta {
  startTick: number;
  durationTicks: number;
}

interface PlayerClipMeta {
  steamid: number;
  clips: ClipMeta[];
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useVoiceLines(): {
  voiceAvailable: boolean;
  voiceLoading: boolean;
  voiceError: string | null;
  speakingPlayerIds: Set<number>;
} {
  const demo             = useAppStore((s) => s.demo);
  const activeRound      = useAppStore((s) => s.activeRound);
  const rounds           = useAppStore((s) => s.rounds);
  const isMultiRoundMode = useAppStore((s) => s.isMultiRoundMode);
  const isHeatmapMode    = useAppStore((s) => s.isHeatmapMode);
  const isPlaying        = useAppStore((s) => s.isPlaying);
  const currentTick      = useAppStore((s) => s.currentTick);
  const mutedPlayerIds   = useAppStore((s) => s.mutedPlayerIds);

  const [voiceLoading, setVoiceLoading]   = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceError, setVoiceError]       = useState<string | null>(null);
  const [clipMeta, setClipMeta]           = useState<PlayerClipMeta[]>([]);

  // Refs that don't trigger re-renders
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const loadedRef          = useRef<LoadedPlayer[]>([]);
  const sourcesRef         = useRef<AudioBufferSourceNode[]>([]);
  const tickRateRef        = useRef<number>(64);

  // Track playback position for seek detection
  const playStartTickRef    = useRef<number>(0);
  const playStartCtxTimeRef = useRef<number>(0);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }, []);

  const stopAll = useCallback(() => {
    for (const src of sourcesRef.current) {
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
    }
    sourcesRef.current = [];
  }, []);

  /**
   * Schedule all unmuted player clips starting from atTick.
   *
   * For each clip:
   *   - Skip if the clip ended before atTick.
   *   - Start at an offset if the clip started before atTick.
   *   - Schedule in the future if the clip starts after atTick.
   */
  const startAll = useCallback((atTick: number) => {
    stopAll();
    if (!loadedRef.current.length) return;

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => null);
    }

    const tickRate = tickRateRef.current;
    const nowCtx   = ctx.currentTime;
    const newSources: AudioBufferSourceNode[] = [];

    for (const player of loadedRef.current) {
      if (mutedPlayerIds.has(player.steamid)) continue;

      for (const clip of player.clips) {
        // Seconds from atTick to the start of this clip (positive = future)
        const clipDelaySec  = (clip.startTick - atTick) / tickRate;
        const clipDuration  = clip.buffer.duration;

        // Skip clips that already ended before atTick
        if (clipDelaySec + clipDuration <= 0) continue;

        const src = ctx.createBufferSource();
        src.buffer = clip.buffer;
        src.connect(ctx.destination);

        if (clipDelaySec <= 0) {
          // Clip already started — play from an offset into the buffer
          const offset = Math.min(-clipDelaySec, clipDuration - 0.001);
          src.start(nowCtx, Math.max(0, offset));
        } else {
          // Clip starts in the future — schedule it
          src.start(nowCtx + clipDelaySec, 0);
        }

        newSources.push(src);
      }
    }

    sourcesRef.current  = newSources;
    playStartTickRef.current    = atTick;
    playStartCtxTimeRef.current = nowCtx;
  }, [stopAll, getAudioCtx, mutedPlayerIds]);

  // ── Load voice when round changes ─────────────────────────────────────────

  useEffect(() => {
    // Noop outside single-round mode
    if (!demo || activeRound === null || isMultiRoundMode || isHeatmapMode) {
      loadedRef.current = [];
      setVoiceAvailable(false);
      setClipMeta([]);
      stopAll();
      return;
    }

    const roundInfo = rounds.find((r) => r.round_number === activeRound);
    if (!roundInfo) return;

    let cancelled = false;
    setVoiceLoading(true);
    setVoiceError(null);
    setVoiceAvailable(false);
    setClipMeta([]);
    loadedRef.current = [];
    stopAll();

    (async () => {
      try {
        const manifest = await getVoiceManifest(demo.id, activeRound);
        if (cancelled) return;

        tickRateRef.current = manifest.tick_rate;

        if (!manifest.available || manifest.players.length === 0) {
          setVoiceAvailable(false);
          setVoiceLoading(false);
          return;
        }

        const ctx = getAudioCtx();
        const loaded: LoadedPlayer[] = [];

        await Promise.all(
          manifest.players.map(async (p) => {
            const playerClips: LoadedClip[] = [];

            await Promise.all(
              p.clips.map(async (clip) => {
                try {
                  const resp = await fetch(clip.audio_url);
                  if (!resp.ok) return;
                  const arrayBuf = await resp.arrayBuffer();
                  if (cancelled) return;
                  const audioBuf = await ctx.decodeAudioData(arrayBuf);
                  if (cancelled) return;
                  playerClips.push({ startTick: clip.start_tick, buffer: audioBuf });
                } catch (err) {
                  console.warn(
                    `Failed to load voice clip for ${p.name} at tick ${clip.start_tick}:`,
                    err,
                  );
                }
              }),
            );

            if (playerClips.length > 0) {
              // Keep clips in tick order for deterministic scheduling
              playerClips.sort((a, b) => a.startTick - b.startTick);
              loaded.push({ steamid: p.steamid, clips: playerClips });
            }
          }),
        );

        if (cancelled) return;
        loadedRef.current = loaded;
        setVoiceAvailable(loaded.length > 0);
        setClipMeta(loaded.map((p) => ({
          steamid: p.steamid,
          clips: p.clips.map((c) => ({
            startTick: c.startTick,
            durationTicks: Math.round(c.buffer.duration * tickRateRef.current),
          })),
        })));
      } catch (err) {
        if (!cancelled) {
          setVoiceError('Voice extraction failed — the demo may not have voice data.');
          console.warn('useVoiceLines error:', err);
        }
      } finally {
        if (!cancelled) setVoiceLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      stopAll();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo?.id, activeRound, isMultiRoundMode, isHeatmapMode]);

  // ── Sync playback with isPlaying / currentTick ────────────────────────────

  const prevTickRef    = useRef<number>(currentTick);
  const prevPlayingRef = useRef<boolean>(false);

  useEffect(() => {
    const prevTick   = prevTickRef.current;
    const wasPlaying = prevPlayingRef.current;
    prevTickRef.current    = currentTick;
    prevPlayingRef.current = isPlaying;

    if (!loadedRef.current.length) return;

    if (!isPlaying) {
      stopAll();
      return;
    }

    // Detect a tick discontinuity (seek or first play)
    const tickRate      = tickRateRef.current;
    const tickDelta     = currentTick - prevTick;
    const expectedDelta = wasPlaying
      ? (getAudioCtx().currentTime - playStartCtxTimeRef.current) * tickRate
      : 0;
    const isSeeked = !wasPlaying || Math.abs(tickDelta - expectedDelta) > 64;

    if (isSeeked) {
      startAll(currentTick);
    }
    // Otherwise audio is already running in sync — no action needed
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentTick]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopAll();
      audioCtxRef.current?.close().catch(() => null);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute which players are currently speaking based on clip tick ranges
  const speakingPlayerIds = useMemo<Set<number>>(() => {
    const s = new Set<number>();
    if (!voiceAvailable) return s;
    for (const p of clipMeta) {
      if (mutedPlayerIds.has(p.steamid)) continue;
      for (const clip of p.clips) {
        if (currentTick >= clip.startTick && currentTick < clip.startTick + clip.durationTicks) {
          s.add(p.steamid);
          break;
        }
      }
    }
    return s;
  }, [clipMeta, currentTick, voiceAvailable, mutedPlayerIds]);

  return { voiceAvailable, voiceLoading, voiceError, speakingPlayerIds };
}
