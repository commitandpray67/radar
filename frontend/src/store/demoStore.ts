/**
 * Global application state via Zustand.
 *
 * Slice responsibilities:
 *  demoStore    – loaded demo metadata, rounds, players, positions, events,
 *                 grenades, player state events
 *  playback     – current round selection, tick cursor, play/pause, speed,
 *                 display toggles
 *  heatmap      – heatmap mode flags, selected players/rounds, result image
 *  multiRound   – multi-round overlay replay mode
 *  ui           – sidebar state, active panel, layer selection
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  DemoMeta,
  RoundInfo,
  PlayerInfo,
  PlayerPosition,
  GameEvent,
  GrenadeEvent,
  PlayerStateEvent,
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
  demo: DemoMeta | null;
  rounds: RoundInfo[];
  players: PlayerInfo[];
  positions: PlayerPosition[];
  events: GameEvent[];
  grenades: GrenadeEvent[];
  playerStateEvents: PlayerStateEvent[];

  maps: MapMeta[];
  currentMap: MapMeta | null;

  tickIndex: TickIndex;
  sortedTicks: number[];

  parseStatus: ParseJobStatus | null;

  positionsLoading: boolean;

  setDemo: (demo: DemoMeta) => void;
  setRounds: (rounds: RoundInfo[]) => void;
  setPlayers: (players: PlayerInfo[]) => void;
  setPositions: (positions: PlayerPosition[], roundNumbers?: number[]) => void;
  setPositionsLoading: (loading: boolean) => void;
  setEvents: (events: GameEvent[]) => void;
  setGrenades: (grenades: GrenadeEvent[]) => void;
  setPlayerStateEvents: (events: PlayerStateEvent[]) => void;
  setMaps: (maps: MapMeta[]) => void;
  setCurrentMap: (map: MapMeta | null) => void;
  setParseStatus: (status: ParseJobStatus | null) => void;
  reset: () => void;
}

interface PlaybackState {
  activeRound: number | null;
  currentTick: number;
  isPlaying: boolean;
  speedMultiplier: number;

  showDeadPlayers: boolean;
  showTrails: boolean;
  trailLengthTicks: number;
  showBomb: boolean;
  showGrenades: boolean;
  showYaw: boolean;

  selectedPlayerIds: Set<number>;

  setActiveRound: (round: number | null) => void;
  setCurrentTick: (tick: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setSpeedMultiplier: (speed: number) => void;
  toggleShowDead: () => void;
  toggleShowTrails: () => void;
  setTrailLength: (ticks: number) => void;
  toggleShowBomb: () => void;
  toggleShowGrenades: () => void;
  toggleShowYaw: () => void;
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
  activeLayerLabel: string;

  setHeatmapMode: (on: boolean) => void;
  setHeatmapRounds: (rounds: number[]) => void;
  toggleHeatmapRound: (round: number) => void;
  setHeatmapResult: (result: HeatmapResult | null) => void;
  setHeatmapLoading: (loading: boolean) => void;
  setHeatmapError: (err: string | null) => void;
  setHeatmapTeamFilter: (filter: 'CT' | 'T' | null) => void;
  setActiveLayer: (label: string) => void;
}

interface MultiRoundState {
  /** Whether multi-round overlay mode is active */
  isMultiRoundMode: boolean;
  /** Round numbers included in the overlay */
  multiRoundSelectedRounds: number[];
  /** SteamID64 player IDs to show (empty = all) */
  multiRoundSelectedPlayers: Set<number>;
  /** Relative tick cursor (0 = freeze_end_tick of each round) */
  multiRoundRelativeTick: number;
  multiRoundIsPlaying: boolean;

  setMultiRoundMode: (on: boolean) => void;
  toggleMultiRoundRound: (rn: number) => void;
  setMultiRoundRounds: (rounds: number[]) => void;
  toggleMultiRoundPlayer: (playerId: number) => void;
  setMultiRoundPlayers: (ids: number[]) => void;
  setMultiRoundRelativeTick: (tick: number) => void;
  setMultiRoundIsPlaying: (playing: boolean) => void;
}

interface UIState {
  sidebarOpen: boolean;
  activePanel: 'rounds' | 'heatmap' | 'players';

  setSidebarOpen: (open: boolean) => void;
  setActivePanel: (panel: UIState['activePanel']) => void;
}

type AppStore = DemoState & PlaybackState & HeatmapState & MultiRoundState & UIState;

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
      positionsLoading: false,
      events: [],
      grenades: [],
      playerStateEvents: [],
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
      setPositionsLoading: (positionsLoading) =>
        set({ positionsLoading }, false, 'setPositionsLoading'),
      setEvents: (events) => set({ events }, false, 'setEvents'),
      setGrenades: (grenades) => set({ grenades }, false, 'setGrenades'),
      setPlayerStateEvents: (playerStateEvents) =>
        set({ playerStateEvents }, false, 'setPlayerStateEvents'),
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
            positionsLoading: false,
            events: [],
            grenades: [],
            playerStateEvents: [],
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
            isMultiRoundMode: false,
            multiRoundSelectedRounds: [],
            multiRoundSelectedPlayers: new Set(),
            multiRoundRelativeTick: 0,
            multiRoundIsPlaying: false,
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
      trailLengthTicks: 192,
      showBomb: true,
      showGrenades: true,
      showYaw: false,
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
      toggleShowGrenades: () =>
        set((s) => ({ showGrenades: !s.showGrenades }), false, 'toggleShowGrenades'),
      toggleShowYaw: () =>
        set((s) => ({ showYaw: !s.showYaw }), false, 'toggleShowYaw'),
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
        set(() => {
          if (!isHeatmapMode) {
            return { isHeatmapMode: false };
          }
          return {
            isHeatmapMode: true,
            // Heatmap and multi-round are mutually exclusive.
            isMultiRoundMode: false,
            multiRoundIsPlaying: false,
            multiRoundRelativeTick: 0,
          };
        }, false, 'setHeatmapMode'),
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

      // ----- Multi-round state -----
      isMultiRoundMode: false,
      multiRoundSelectedRounds: [],
      multiRoundSelectedPlayers: new Set(),
      multiRoundRelativeTick: 0,
      multiRoundIsPlaying: false,

      setMultiRoundMode: (on) => {
        set(() => {
          if (!on) {
            return {
              isMultiRoundMode: false,
              multiRoundRelativeTick: 0,
              multiRoundIsPlaying: false,
            };
          }
          return {
            isMultiRoundMode: true,
            multiRoundRelativeTick: 0,
            multiRoundIsPlaying: false,
            // Heatmap and multi-round are mutually exclusive.
            isHeatmapMode: false,
            heatmapResult: null,
            heatmapError: null,
            heatmapLoading: false,
            selectedRoundsForHeatmap: [],
          };
        },
        false,
        'setMultiRoundMode',
        );
      },
      toggleMultiRoundRound: (rn) =>
        set((s) => {
          const next = s.multiRoundSelectedRounds.includes(rn)
            ? s.multiRoundSelectedRounds.filter((r) => r !== rn)
            : [...s.multiRoundSelectedRounds, rn];
          return { multiRoundSelectedRounds: next };
        }, false, 'toggleMultiRoundRound'),
      setMultiRoundRounds: (rounds) =>
        set({ multiRoundSelectedRounds: rounds }, false, 'setMultiRoundRounds'),
      toggleMultiRoundPlayer: (playerId) =>
        set((s) => {
          const next = new Set(s.multiRoundSelectedPlayers);
          if (next.has(playerId)) next.delete(playerId);
          else next.add(playerId);
          return { multiRoundSelectedPlayers: next };
        }, false, 'toggleMultiRoundPlayer'),
      setMultiRoundPlayers: (ids) =>
        set({ multiRoundSelectedPlayers: new Set(ids) }, false, 'setMultiRoundPlayers'),
      setMultiRoundRelativeTick: (tick) =>
        set({ multiRoundRelativeTick: tick }, false, 'setMultiRoundRelativeTick'),
      setMultiRoundIsPlaying: (playing) =>
        set({ multiRoundIsPlaying: playing }, false, 'setMultiRoundIsPlaying'),

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

// Convenience selectors
export const useDemo = () => useAppStore((s) => s.demo);
export const useRounds = () => useAppStore((s) => s.rounds);
export const usePlayers = () => useAppStore((s) => s.players);
export const useActiveRound = () => useAppStore((s) => s.activeRound);
export const useCurrentTick = () => useAppStore((s) => s.currentTick);
export const useIsPlaying = () => useAppStore((s) => s.isPlaying);
export const useSelectedPlayers = () => useAppStore((s) => s.selectedPlayerIds);
export const useHeatmapMode = () => useAppStore((s) => s.isHeatmapMode);
export const useCurrentMap = () => useAppStore((s) => s.currentMap);
export const useIsMultiRoundMode = () => useAppStore((s) => s.isMultiRoundMode);
