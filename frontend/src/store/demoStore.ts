/**
 * Global application state via Zustand.
 *
 * Slice responsibilities:
 *  demoStore  – loaded demo metadata, rounds, players, and position data
 *  playback   – current round selection, tick cursor, play/pause, speed
 *  heatmap    – heatmap mode flags, selected players/rounds, result image
 *  ui         – sidebar state, active panel, layer selection
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  DemoMeta,
  RoundInfo,
  PlayerInfo,
  PlayerPosition,
  GameEvent,
  MapMeta,
  HeatmapResult,
  ParseJobStatus,
} from '../types';
import {
  buildTickIndex,
  getSortedTicks,
  type TickIndex,
} from '../utils/playback';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface DemoState {
  // Loaded data
  demo: DemoMeta | null;
  rounds: RoundInfo[];
  players: PlayerInfo[];
  positions: PlayerPosition[];
  events: GameEvent[];

  // Map calibration data from server
  maps: MapMeta[];
  currentMap: MapMeta | null;

  // Pre-built lookup for fast tick-based queries
  tickIndex: TickIndex;
  sortedTicks: number[];

  // Parse-job status
  parseStatus: ParseJobStatus | null;

  // Actions
  setDemo: (demo: DemoMeta) => void;
  setRounds: (rounds: RoundInfo[]) => void;
  setPlayers: (players: PlayerInfo[]) => void;
  setPositions: (positions: PlayerPosition[], roundNumbers?: number[]) => void;
  setEvents: (events: GameEvent[]) => void;
  setMaps: (maps: MapMeta[]) => void;
  setCurrentMap: (map: MapMeta | null) => void;
  setParseStatus: (status: ParseJobStatus | null) => void;
  reset: () => void;
}

interface PlaybackState {
  // Which round is currently selected for viewing
  activeRound: number | null;
  // The current tick cursor (absolute tick number)
  currentTick: number;
  isPlaying: boolean;
  speedMultiplier: number;   // 0.25 | 0.5 | 1 | 2 | 4

  // UI toggles
  showDeadPlayers: boolean;
  showTrails: boolean;
  trailLengthTicks: number;
  showBomb: boolean;

  // Selected players for filtering/heatmap
  selectedPlayerIds: Set<number>;

  // Actions
  setActiveRound: (round: number | null) => void;
  setCurrentTick: (tick: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setSpeedMultiplier: (speed: number) => void;
  toggleShowDead: () => void;
  toggleShowTrails: () => void;
  setTrailLength: (ticks: number) => void;
  toggleShowBomb: () => void;
  togglePlayerSelection: (playerId: number) => void;
  setSelectedPlayers: (ids: number[]) => void;
  clearSelectedPlayers: () => void;
}

interface HeatmapState {
  isHeatmapMode: boolean;
  selectedRoundsForHeatmap: number[];
  heatmapResult: HeatmapResult | null;
  heatmapLoading: boolean;
  heatmapError: string | null;
  heatmapTeamFilter: 'CT' | 'T' | null;
  activeLayerLabel: string;      // "" for single-level, "Upper"/"Lower" for multi

  setHeatmapMode: (on: boolean) => void;
  setHeatmapRounds: (rounds: number[]) => void;
  toggleHeatmapRound: (round: number) => void;
  setHeatmapResult: (result: HeatmapResult | null) => void;
  setHeatmapLoading: (loading: boolean) => void;
  setHeatmapError: (err: string | null) => void;
  setHeatmapTeamFilter: (filter: 'CT' | 'T' | null) => void;
  setActiveLayer: (label: string) => void;
}

interface UIState {
  sidebarOpen: boolean;
  activePanel: 'rounds' | 'heatmap' | 'players';

  setSidebarOpen: (open: boolean) => void;
  setActivePanel: (panel: UIState['activePanel']) => void;
}

// Combined store type
type AppStore = DemoState & PlaybackState & HeatmapState & UIState;

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useAppStore = create<AppStore>()(
  devtools(
    (set, get) => ({

      // ----- Demo state -----
      demo: null,
      rounds: [],
      players: [],
      positions: [],
      events: [],
      maps: [],
      currentMap: null,
      tickIndex: new Map(),
      sortedTicks: [],
      parseStatus: null,

      setDemo: (demo) => set({ demo }, false, 'setDemo'),
      setRounds: (rounds) => set({ rounds }, false, 'setRounds'),
      setPlayers: (players) => set({ players }, false, 'setPlayers'),
      setPositions: (positions, roundNumbers) => {
        const tickIndex = buildTickIndex(positions, roundNumbers);
        const sortedTicks = getSortedTicks(tickIndex);
        set({ positions, tickIndex, sortedTicks }, false, 'setPositions');
      },
      setEvents: (events) => set({ events }, false, 'setEvents'),
      setMaps: (maps) => set({ maps }, false, 'setMaps'),
      setCurrentMap: (map) => set({ currentMap: map }, false, 'setCurrentMap'),
      setParseStatus: (parseStatus) => set({ parseStatus }, false, 'setParseStatus'),

      reset: () =>
        set(
          {
            demo: null,
            rounds: [],
            players: [],
            positions: [],
            events: [],
            currentMap: null,
            tickIndex: new Map(),
            sortedTicks: [],
            parseStatus: null,
            activeRound: null,
            currentTick: 0,
            isPlaying: false,
            heatmapResult: null,
            heatmapLoading: false,
            heatmapError: null,
            selectedPlayerIds: new Set(),
            selectedRoundsForHeatmap: [],
          },
          false,
          'reset',
        ),

      // ----- Playback state -----
      activeRound: null,
      currentTick: 0,
      isPlaying: false,
      speedMultiplier: 1,
      showDeadPlayers: true,
      showTrails: false,
      trailLengthTicks: 192,  // ~3 s at 64 tick
      showBomb: true,
      selectedPlayerIds: new Set(),

      setActiveRound: (round) => {
        const { rounds } = get();
        const roundInfo = rounds.find((r) => r.round_number === round);
        set(
          {
            activeRound: round,
            currentTick: roundInfo ? roundInfo.freeze_end_tick : 0,
            isPlaying: false,
          },
          false,
          'setActiveRound',
        );
      },
      setCurrentTick: (tick) => set({ currentTick: tick }, false, 'setCurrentTick'),
      setIsPlaying: (isPlaying) => set({ isPlaying }, false, 'setIsPlaying'),
      setSpeedMultiplier: (speedMultiplier) =>
        set({ speedMultiplier }, false, 'setSpeedMultiplier'),
      toggleShowDead: () =>
        set((s) => ({ showDeadPlayers: !s.showDeadPlayers }), false, 'toggleShowDead'),
      toggleShowTrails: () =>
        set((s) => ({ showTrails: !s.showTrails }), false, 'toggleShowTrails'),
      setTrailLength: (ticks) =>
        set({ trailLengthTicks: ticks }, false, 'setTrailLength'),
      toggleShowBomb: () =>
        set((s) => ({ showBomb: !s.showBomb }), false, 'toggleShowBomb'),
      togglePlayerSelection: (playerId) =>
        set((s) => {
          const next = new Set(s.selectedPlayerIds);
          if (next.has(playerId)) next.delete(playerId);
          else next.add(playerId);
          return { selectedPlayerIds: next };
        }, false, 'togglePlayerSelection'),
      setSelectedPlayers: (ids) =>
        set({ selectedPlayerIds: new Set(ids) }, false, 'setSelectedPlayers'),
      clearSelectedPlayers: () =>
        set({ selectedPlayerIds: new Set() }, false, 'clearSelectedPlayers'),

      // ----- Heatmap state -----
      isHeatmapMode: false,
      selectedRoundsForHeatmap: [],
      heatmapResult: null,
      heatmapLoading: false,
      heatmapError: null,
      heatmapTeamFilter: null,
      activeLayerLabel: '',

      setHeatmapMode: (isHeatmapMode) =>
        set({ isHeatmapMode }, false, 'setHeatmapMode'),
      setHeatmapRounds: (rounds) =>
        set({ selectedRoundsForHeatmap: rounds }, false, 'setHeatmapRounds'),
      toggleHeatmapRound: (round) =>
        set((s) => {
          const next = s.selectedRoundsForHeatmap.includes(round)
            ? s.selectedRoundsForHeatmap.filter((r) => r !== round)
            : [...s.selectedRoundsForHeatmap, round];
          return { selectedRoundsForHeatmap: next };
        }, false, 'toggleHeatmapRound'),
      setHeatmapResult: (heatmapResult) =>
        set({ heatmapResult }, false, 'setHeatmapResult'),
      setHeatmapLoading: (heatmapLoading) =>
        set({ heatmapLoading }, false, 'setHeatmapLoading'),
      setHeatmapError: (heatmapError) =>
        set({ heatmapError }, false, 'setHeatmapError'),
      setHeatmapTeamFilter: (heatmapTeamFilter) =>
        set({ heatmapTeamFilter }, false, 'setHeatmapTeamFilter'),
      setActiveLayer: (activeLayerLabel) =>
        set({ activeLayerLabel }, false, 'setActiveLayer'),

      // ----- UI state -----
      sidebarOpen: true,
      activePanel: 'rounds',

      setSidebarOpen: (sidebarOpen) =>
        set({ sidebarOpen }, false, 'setSidebarOpen'),
      setActivePanel: (activePanel) =>
        set({ activePanel }, false, 'setActivePanel'),
    }),
    { name: 'CS2Radar' },
  ),
);

// Convenience selectors (avoids re-render on unrelated state changes)
export const useDemo = () => useAppStore((s) => s.demo);
export const useRounds = () => useAppStore((s) => s.rounds);
export const usePlayers = () => useAppStore((s) => s.players);
export const useActiveRound = () => useAppStore((s) => s.activeRound);
export const useCurrentTick = () => useAppStore((s) => s.currentTick);
export const useIsPlaying = () => useAppStore((s) => s.isPlaying);
export const useSelectedPlayers = () => useAppStore((s) => s.selectedPlayerIds);
export const useHeatmapMode = () => useAppStore((s) => s.isHeatmapMode);
export const useCurrentMap = () => useAppStore((s) => s.currentMap);
