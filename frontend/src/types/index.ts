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
  file_size?: number;    // bytes
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
  ct_equip_value?: number;
  t_equip_value?: number;
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
  yaw?: number;         // view angle degrees (0=East)
  /** Tagged client-side in team-session multi-round mode to disambiguate same
   *  round_number coming from different demos. Undefined in single-demo mode. */
  demo_id?: string;
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

// ---------------------------------------------------------------------------
// Team session (multi-demo analysis)
// ---------------------------------------------------------------------------

export interface TeamSessionDemoInfo {
  demo_id: string;
  filename: string;
  map_name: string;
  parsed_at: string;
  file_size: number;
}

/** Result of POST /api/team-sessions/validate */
export interface TeamSessionValidation {
  ok: boolean;
  error: string | null;
  map_name: string | null;
  team_sides: Record<string, 'CT' | 'T'>;     // demo_id -> side
  core_roster: string[];                       // SteamID64 strings
  extended_roster: string[];                   // SteamID64 strings
  roster_names: Record<string, string>;        // SteamID -> display name
  demos: TeamSessionDemoInfo[];
}

export interface TeamSessionListItem {
  id: string;
  name: string;
  map_name: string;
  demo_count: number;
  created_at: string;
}

export interface TeamSessionDetail {
  id: string;
  name: string;
  map_name: string;
  created_at: string;
  demo_ids: string[];
  team_sides: Record<string, 'CT' | 'T'>;
  core_roster: string[];
  extended_roster: string[];
  roster_names: Record<string, string>;
  demos: Array<DemoMeta>;
  rounds: RoundInfo[];      // RoundInfo.demo_id distinguishes which demo each came from
}

/** Composite round identity in team mode: (demo_id, round_number). */
export interface TeamRoundRef {
  demo_id: string;
  round_number: number;
}

export interface TeamSessionHeatmapPayload {
  rounds: TeamRoundRef[];
  player_ids: string[];           // SteamID64 strings
  layer_label?: string;
  exclude_freeze_time?: boolean;
  team_filter?: 'team' | 'opponent' | null;
  sample_every?: number;
  blur_sigma?: number;
}

// ---------------------------------------------------------------------------
// Team organizer (multi-map team management)
// ---------------------------------------------------------------------------

export interface TeamInfo {
  id: string;
  name: string;
  created_at: string;
  demo_count: number;
}

export interface TeamMapGroup {
  map_name: string;
  demos: DemoMeta[];
}

export interface TeamDetail {
  id: string;
  name: string;
  created_at: string;
  maps: TeamMapGroup[];
}

// ---------------------------------------------------------------------------
// FACEIT integration
// ---------------------------------------------------------------------------

export interface FaceitResolvedPlayer {
  nickname: string;
  player_id: string | null;
  avatar: string;
  country: string;
  skill_level: number | null;
  found: boolean;
  error: string | null;
}

export interface FaceitSelectedPlayer {
  player_id: string;
  nickname: string;
  faction: string;            // "faction1" | "faction2"
  skill_level: number | null;
}

export interface FaceitMatchSummary {
  match_id: string;
  started_at: number;         // unix seconds
  finished_at: number;
  competition_name: string;
  competition_type: string;
  region: string;
  faceit_url: string;
  score: string;
  selected_players: FaceitSelectedPlayer[];
}

export interface FaceitCommonMatches {
  matches: FaceitMatchSummary[];
  analyzed: number;
}

export interface FaceitMapStat {
  map: string;
  played: number;
  wins: number;
  losses: number;
  win_rate: number;           // 0..1
  preference_pct: number;     // 0..1
}

export interface FaceitStackMapStats {
  total_matches: number;
  analyzed: number;
  maps: FaceitMapStat[];
}

export interface FaceitLoadResult {
  job_id: string;
  demo_id: string;
  cached: boolean;
}
