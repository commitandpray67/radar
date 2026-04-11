/**
 * useVoiceLines — synchronises CS2 demo voice audio with single-round playback.
 *
 * Behaviour
 * ---------
 * - Voice data is fetched lazily when a round is selected (not on demo upload).
 * - Only active in single-round mode (noop in multi-round or heatmap mode).
 * - Each player's audio is a WAV covering the whole round; silence fills gaps.
 * - Playback starts at offset (currentTick - round.start_tick) / tickRate.
 * - When isPlaying → true  : all unmuted players start playing from current offset.
 * - When isPlaying → false : all sources are stopped.
 * - Seek (currentTick jumps > 64 ticks while playing) : sources restart at new offset.
 * - Mute toggles take effect at the next play/seek.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppStore } from '../store/demoStore';
import { getVoiceManifest, type VoiceManifest } from '../utils/api';

// ── Types ──────────────────────────────────────────────────────────────────

interface LoadedAudio {
  steamid: number;
  buffer: AudioBuffer;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useVoiceLines(): {
  voiceAvailable: boolean;
  voiceLoading: boolean;
  voiceError: string | null;
} {
  const demo             = useAppStore((s) => s.demo);
  const activeRound      = useAppStore((s) => s.activeRound);
  const rounds           = useAppStore((s) => s.rounds);
  const isMultiRoundMode = useAppStore((s) => s.isMultiRoundMode);
  const isHeatmapMode    = useAppStore((s) => s.isHeatmapMode);
  const isPlaying        = useAppStore((s) => s.isPlaying);
  const currentTick      = useAppStore((s) => s.currentTick);
  const mutedPlayerIds   = useAppStore((s) => s.mutedPlayerIds);

  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceError, setVoiceError]     = useState<string | null>(null);

  // Refs that don't trigger re-renders
  const audioCtxRef     = useRef<AudioContext | null>(null);
  const manifestRef     = useRef<VoiceManifest | null>(null);
  const loadedRef       = useRef<LoadedAudio[]>([]);
  const sourcesRef      = useRef<AudioBufferSourceNode[]>([]);

  // Track playback position for seek detection
  const playStartTickRef      = useRef<number>(0);
  const playStartCtxTimeRef   = useRef<number>(0);

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

  const startAll = useCallback((offsetSeconds: number) => {
    stopAll();
    if (!loadedRef.current.length) return;

    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => null);
    }

    const newSources: AudioBufferSourceNode[] = [];
    for (const { steamid, buffer } of loadedRef.current) {
      if (mutedPlayerIds.has(steamid)) continue;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      // Clamp offset to valid range
      const safeOffset = Math.max(0, Math.min(offsetSeconds, buffer.duration - 0.01));
      src.start(0, safeOffset);
      newSources.push(src);
    }
    sourcesRef.current = newSources;

    playStartTickRef.current    = currentTick;
    playStartCtxTimeRef.current = getAudioCtx().currentTime;
  }, [stopAll, getAudioCtx, mutedPlayerIds, currentTick]);

  // ── Load voice when round changes ─────────────────────────────────────────

  useEffect(() => {
    // Only active in single-round mode
    if (!demo || activeRound === null || isMultiRoundMode || isHeatmapMode) {
      loadedRef.current = [];
      manifestRef.current = null;
      setVoiceAvailable(false);
      stopAll();
      return;
    }

    const roundInfo = rounds.find((r) => r.round_number === activeRound);
    if (!roundInfo) return;

    let cancelled = false;
    setVoiceLoading(true);
    setVoiceError(null);
    setVoiceAvailable(false);
    loadedRef.current = [];
    manifestRef.current = null;
    stopAll();

    (async () => {
      try {
        const manifest = await getVoiceManifest(demo.id, activeRound);
        if (cancelled) return;

        manifestRef.current = manifest;

        if (!manifest.available || manifest.players.length === 0) {
          setVoiceAvailable(false);
          setVoiceLoading(false);
          return;
        }

        const ctx = getAudioCtx();
        const loaded: LoadedAudio[] = [];

        await Promise.all(
          manifest.players.map(async (p) => {
            try {
              const resp = await fetch(p.audio_url);
              if (!resp.ok) return;
              const arrayBuf = await resp.arrayBuffer();
              if (cancelled) return;
              const audioBuf = await ctx.decodeAudioData(arrayBuf);
              if (cancelled) return;
              loaded.push({ steamid: p.steamid, buffer: audioBuf });
            } catch (err) {
              console.warn(`Failed to load voice for ${p.name}:`, err);
            }
          })
        );

        if (cancelled) return;
        loadedRef.current = loaded;
        setVoiceAvailable(loaded.length > 0);
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

  const prevTickRef      = useRef<number>(currentTick);
  const prevPlayingRef   = useRef<boolean>(false);
  const manifest         = manifestRef.current;

  useEffect(() => {
    const prevTick    = prevTickRef.current;
    const wasPlaying  = prevPlayingRef.current;
    prevTickRef.current   = currentTick;
    prevPlayingRef.current = isPlaying;

    if (!manifest || !loadedRef.current.length) return;

    const startTick = manifest.start_tick;
    const tickRate  = manifest.tick_rate;
    const offsetSec = (currentTick - startTick) / tickRate;

    if (!isPlaying) {
      // Pause: stop all audio
      stopAll();
      return;
    }

    // Started playing or seeked — detect a tick discontinuity
    const tickDelta    = currentTick - prevTick;
    const expectedDelta = wasPlaying
      ? (getAudioCtx().currentTime - playStartCtxTimeRef.current) * tickRate
      : 0;
    const isSeeked = !wasPlaying || Math.abs(tickDelta - expectedDelta) > 64;

    if (isSeeked) {
      startAll(offsetSec);
    }
    // Otherwise audio is already playing in sync — no action needed
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

  return { voiceAvailable, voiceLoading, voiceError };
}
