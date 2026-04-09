// ---------------------------------------------------------------------------
// Domain types — mirror the backend normalised schema
// ---------------------------------------------------------------------------

export interface DemoMeta {
  id: string;            // SHA-256 fingerprint
  filename: string;
  map_name: string;
  tick_rate: number;
  total_ticks: number;
  parsed_at: string;     // ISO timestamp
}

export interface RoundInfo {
  id: number;
  demo_id: string;
  round_number: number;
  start_tick: number;
  end_tick: number;
  freeze_end_tick: number;
  winner_team: 'CT' | 'T' | '';
  win_reason: string;
  ct_score: number;
  t_score: number;
  bomb_planted_tick: number | null;
  bomb_defused_tick: number | null;
  bomb_exploded_tick: number | null;
  is_knife_round?: boolean;
}

export interface PlayerInfo {
  id: number;
  demo_id: string;
  player_id: number;    // SteamID64
  name: string;
  initial_team: 'CT' | 'T' | 'Spectator' | string;
}

export interface PlayerPosition {
  tick: number;
  round_number: number;
  player_id: number;
  x: number;
  y: number;
  z: number;
  team_num: number;     // 2 = T, 3 = CT
  is_alive: number;     // 0 | 1 (from SQLite)
}

export interface GameEvent {
  id: number;
  demo_id: string;
  tick: number;
  round_number: number;
  event_type: 'player_death' | 'bomb_planted' | 'bomb_defused' | 'bomb_exploded' | string;
  attacker_id: number | null;
  victim_id: number | null;
  weapon: string | null;
  headshot: number;     // 0 | 1
}

// ---------------------------------------------------------------------------
// Map calibration (mirrors backend MapCalibration)
// ---------------------------------------------------------------------------

export interface RadarLayerMeta {
  label: string;
  image: string;
  z_min: number;
  z_max: number;
}

export interface MapMeta {
  name: string;
  is_multilevel: boolean;
  image: string;         // single-level radar image filename
  layers: RadarLayerMeta[];
}

// ---------------------------------------------------------------------------
// Radar coordinate helper type
// ---------------------------------------------------------------------------

/** A 2-D point in radar image pixel space [0, 1024]. */
export interface RadarPoint {
  px: number;
  py: number;
}

// ---------------------------------------------------------------------------
// Parse job status (SSE payload)
// ---------------------------------------------------------------------------

export interface ParseJobStatus {
  status: 'pending' | 'running' | 'complete' | 'error';
  progress: number;      // 0.0 → 1.0
  message: string;
  demo_id: string;
  filename: string;
  map_name?: string;
}

// ---------------------------------------------------------------------------
// Heatmap API
// ---------------------------------------------------------------------------

export interface HeatmapPayload {
  player_ids: number[];
  round_numbers: number[];
  layer_label?: string;
  exclude_freeze_time?: boolean;
  team_filter?: 'CT' | 'T' | null;
  sample_every?: number;
  blur_sigma?: number;
}

export interface HeatmapResult {
  image: string;         // data:image/png;base64,...
  sample_count: number;
  layer_label: string;
}

// ---------------------------------------------------------------------------
// Grenade events
// ---------------------------------------------------------------------------

export type GrenadeType = 'he' | 'flash' | 'smoke' | 'molotov' | 'incendiary' | 'decoy';

export interface GrenadeEvent {
  id: number;
  demo_id: string;
  round_number: number;
  thrower_id: number;       // SteamID64
  grenade_type: GrenadeType;
  throw_tick: number;
  detonate_tick: number | null;
  x: number;                // world detonation position
  y: number;
  z: number;
  expire_tick: number | null;
  trajectory?: Array<{
    tick: number;
    x: number;
    y: number;
    z: number;
  }> | null;
}

// ---------------------------------------------------------------------------
// Player state events (HP, armor, weapon equip)
// ---------------------------------------------------------------------------

export type PlayerStateEventType = 'hurt' | 'equip' | 'spawn';

export interface PlayerStateEvent {
  id: number;
  demo_id: string;
  tick: number;
  round_number: number;
  player_id: number;        // SteamID64
  event_type: PlayerStateEventType;
  hp: number | null;
  armor: number | null;
  weapon: string | null;
}

// ---------------------------------------------------------------------------
// Playback state helpers
// ---------------------------------------------------------------------------

/** A snapshot of all players at a single tick (computed client-side). */
export type TickSnapshot = Map<number, PlayerPosition>;

/** Team colour constants */
export const TEAM_COLORS = {
  CT: '#5b9bd5',   // steel blue
  T:  '#e07b39',   // burnt orange
  dead: '#666666',
} as const;

export type TeamColor = typeof TEAM_COLORS[keyof typeof TEAM_COLORS];
