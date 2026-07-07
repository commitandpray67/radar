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
  TeamSessionDetail,
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

  /** Extend single-round playback to cover freeze time + post-round restart
   *  delay so voice comms in those windows can be heard. */
  extendedPlayback: boolean;
  /** When extended playback is on, auto-advance to the next round at the end
   *  instead of pausing. */
  continuousPlayback: boolean;

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
  toggleExtendedPlayback: () => void;
  toggleContinuousPlayback: () => void;
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
  /** Round numbers included in the overlay (single-demo) */
  multiRoundSelectedRounds: number[];
  /** Composite "demoId:roundNumber" keys in team-session multi-round mode */
  multiRoundTeamKeys: string[];
  /** SteamID64 player IDs to show (empty = all) */
  multiRoundSelectedPlayers: Set<number>;
  /** Relative tick cursor (0 = freeze_end_tick of each round) */
  multiRoundRelativeTick: number;
  multiRoundIsPlaying: boolean;

  setMultiRoundMode: (on: boolean) => void;
  toggleMultiRoundRound: (rn: number) => void;
  setMultiRoundRounds: (rounds: number[]) => void;
  toggleMultiRoundTeamKey: (key: string) => void;
  setMultiRoundTeamKeys: (keys: string[]) => void;
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

// Voice / mute state
interface VoiceState {
  /** SteamID64s of players whose voice is muted */
  mutedPlayerIds: Set<number>;
  toggleMutePlayer: (playerId: number) => void;
  mutePlayers: (playerIds: number[]) => void;
  unmutePlayers: (playerIds: number[]) => void;
  muteAll: () => void;
  unmuteAll: () => void;
}

// ---------------------------------------------------------------------------
// Team session state — when active, the standard single-demo slots
// (demo/rounds/players/events/…) hold the data for the currently-active demo
// within the session. The team session itself remembers which demos belong
// and which side our team played in each.
// ---------------------------------------------------------------------------

interface TeamSessionState {
  /** The active team session, or null when in single-demo mode. */
  teamSession: TeamSessionDetail | null;
  /** demo_id currently loaded into the single-demo slots when in a team session. */
  activeDemoId: string | null;
  /** Cross-demo round selection for heatmap mode: keys "demo_id:round_number". */
  teamHeatmapRoundKeys: string[];

  setTeamSession: (session: TeamSessionDetail | null) => void;
  setActiveDemoId: (demoId: string | null) => void;
  setTeamHeatmapRoundKeys: (keys: string[]) => void;
  toggleTeamHeatmapRoundKey: (key: string) => void;
}

type AppStore = DemoState & PlaybackState & HeatmapState & MultiRoundState
  & UIState & VoiceState & TeamSessionState;

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
            extendedPlayback: false,
            continuousPlayback: false,
            heatmapResult: null,
            heatmapLoading: false,
            heatmapError: null,
            selectedPlayerIds: new Set(),
            selectedRoundsForHeatmap: [],
            isMultiRoundMode: false,
            multiRoundSelectedRounds: [],
            multiRoundTeamKeys: [],
            multiRoundSelectedPlayers: new Set(),
            multiRoundRelativeTick: 0,
            multiRoundIsPlaying: false,
            mutedPlayerIds: new Set<number>(),
            teamSession: null,
            activeDemoId: null,
            teamHeatmapRoundKeys: [],
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
      extendedPlayback: false,
      continuousPlayback: false,
      selectedPlayerIds: new Set(),

      setActiveRound: (round) => {
        const { rounds } = get();
        const roundInfo = rounds.find((r) => r.round_number === round);
        set(
          {
            activeRound: round,
            // Start at the round's very beginning (includes freeze time) so
            // voice communication during buy phase can be heard.
            currentTick: roundInfo ? roundInfo.start_tick : 0,
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
      toggleExtendedPlayback: () =>
        set((s) => (
          // Turning extended playback off also disables continuous playback,
          // since the continuous toggle only exists while extended is on.
          s.extendedPlayback
            ? { extendedPlayback: false, continuousPlayback: false }
            : { extendedPlayback: true }
        ), false, 'toggleExtendedPlayback'),
      toggleContinuousPlayback: () =>
        set((s) => ({ continuousPlayback: !s.continuousPlayback }), false,
          'toggleContinuousPlayback'),
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
      multiRoundTeamKeys: [],
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
      toggleMultiRoundTeamKey: (key) =>
        set((s) => {
          const next = s.multiRoundTeamKeys.includes(key)
            ? s.multiRoundTeamKeys.filter((k) => k !== key)
            : [...s.multiRoundTeamKeys, key];
          return { multiRoundTeamKeys: next };
        }, false, 'toggleMultiRoundTeamKey'),
      setMultiRoundTeamKeys: (keys) =>
        set({ multiRoundTeamKeys: keys }, false, 'setMultiRoundTeamKeys'),
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

      // ----- Team session state -----
      teamSession: null,
      activeDemoId: null,
      teamHeatmapRoundKeys: [],

      setTeamSession: (teamSession) =>
        set({
          teamSession,
          teamHeatmapRoundKeys: [],
          multiRoundTeamKeys: [],
        }, false, 'setTeamSession'),
      setActiveDemoId: (activeDemoId) => set({ activeDemoId }, false, 'setActiveDemoId'),
      setTeamHeatmapRoundKeys: (teamHeatmapRoundKeys) =>
        set({ teamHeatmapRoundKeys }, false, 'setTeamHeatmapRoundKeys'),
      toggleTeamHeatmapRoundKey: (key) =>
        set((s) => {
          const next = s.teamHeatmapRoundKeys.includes(key)
            ? s.teamHeatmapRoundKeys.filter((k) => k !== key)
            : [...s.teamHeatmapRoundKeys, key];
          return { teamHeatmapRoundKeys: next };
        }, false, 'toggleTeamHeatmapRoundKey'),

      // ----- UI state -----
      sidebarOpen: true,
      activePanel: 'rounds',

      setSidebarOpen: (sidebarOpen) =>
        set({ sidebarOpen }, false, 'setSidebarOpen'),
      setActivePanel: (activePanel) =>
        set({ activePanel }, false, 'setActivePanel'),

      // ----- Voice / mute state -----
      mutedPlayerIds: new Set<number>(),

      toggleMutePlayer: (playerId) =>
        set((s) => {
          const next = new Set(s.mutedPlayerIds);
          if (next.has(playerId)) next.delete(playerId);
          else next.add(playerId);
          return { mutedPlayerIds: next };
        }, false, 'toggleMutePlayer'),

      mutePlayers: (playerIds) =>
        set((s) => {
          const next = new Set(s.mutedPlayerIds);
          for (const id of playerIds) next.add(id);
          return { mutedPlayerIds: next };
        }, false, 'mutePlayers'),

      unmutePlayers: (playerIds) =>
        set((s) => {
          const next = new Set(s.mutedPlayerIds);
          for (const id of playerIds) next.delete(id);
          return { mutedPlayerIds: next };
        }, false, 'unmutePlayers'),

      muteAll: () =>
        set((s) => ({
          mutedPlayerIds: new Set(s.players.map((p) => p.player_id)),
        }), false, 'muteAll'),

      unmuteAll: () =>
        set({ mutedPlayerIds: new Set<number>() }, false, 'unmuteAll'),
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
