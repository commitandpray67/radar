/**
 * Thin typed wrappers around the FastAPI backend.
 * All requests go through /api (proxied by Vite in dev).
 */

import axios from 'axios';
import type {
  DemoMeta,
  RoundInfo,
  PlayerInfo,
  PlayerPosition,
  GameEvent,
  GrenadeEvent,
  PlayerStateEvent,
  MapMeta,
  HeatmapPayload,
  HeatmapResult,
  ParseJobStatus,
} from '../types';

const http = axios.create({ baseURL: '/api' });

// ---------------------------------------------------------------------------
// Demos
// ---------------------------------------------------------------------------

export async function uploadDemo(
  file: File,
  onProgress?: (pct: number) => void,
  force = false,
): Promise<{ job_id: string; demo_id: string; cached: boolean }> {
  const form = new FormData();
  form.append('file', file);
  const res = await http.post(`/demos/upload${force ? '?force=true' : ''}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    },
  });
  return res.data;
}

export async function listDemos(): Promise<DemoMeta[]> {
  const res = await http.get('/demos');
  return res.data;
}

export async function getDemo(demoId: string, signal?: AbortSignal): Promise<DemoMeta> {
  const res = await http.get(`/demos/${demoId}`, { signal });
  return res.data;
}

export async function deleteDemo(demoId: string): Promise<void> {
  await http.delete(`/demos/${demoId}`);
}

// ---------------------------------------------------------------------------
// Parse-status SSE
// ---------------------------------------------------------------------------

/**
 * Open an SSE stream for parse-job progress.
 * Automatically reconnects up to `maxRetries` times if the connection drops
 * (e.g. because uvicorn reloaded during development).
 * Resolves when status === 'complete', rejects on status === 'error' or
 * when all retries are exhausted.
 */
export function watchParseStatus(
  jobId: string,
  onStatus: (s: ParseJobStatus) => void,
  maxRetries = 10,
): Promise<ParseJobStatus> {
  return new Promise((resolve, reject) => {
    let retries = 0;
    let lastStatus: ParseJobStatus | null = null;
    let es: EventSource;

    function connect() {
      es = new EventSource(`/api/parse-status/${jobId}`);

      es.onmessage = (event) => {
        // Reset retry counter on any successful message
        retries = 0;
        const status: ParseJobStatus = JSON.parse(event.data);
        lastStatus = status;
        onStatus(status);
        if (status.status === 'complete') {
          es.close();
          resolve(status);
        } else if (status.status === 'error') {
          es.close();
          reject(new Error(status.message));
        }
      };

      es.onerror = () => {
        es.close();
        // If already complete/error from a previous message, ignore the disconnect
        if (lastStatus?.status === 'complete') return;
        if (lastStatus?.status === 'error') return;

        retries += 1;
        if (retries > maxRetries) {
          reject(new Error(
            `Lost connection to server after ${maxRetries} retries. ` +
            `Is the backend still running?`
          ));
          return;
        }

        // Notify the UI that we're reconnecting
        if (lastStatus) {
          onStatus({
            ...lastStatus,
            message: `Reconnecting… (attempt ${retries}/${maxRetries})`,
          });
        }

        // Exponential back-off: 500ms, 1s, 2s, 4s … capped at 8s
        const delay = Math.min(500 * Math.pow(2, retries - 1), 8000);
        setTimeout(connect, delay);
      };
    }

    connect();
  });
}

// ---------------------------------------------------------------------------
// Rounds / Players / Positions / Events
// ---------------------------------------------------------------------------

export async function getRounds(demoId: string, signal?: AbortSignal): Promise<RoundInfo[]> {
  const res = await http.get(`/demos/${demoId}/rounds`, { signal });
  return res.data;
}

export async function getPlayers(demoId: string, signal?: AbortSignal): Promise<PlayerInfo[]> {
  const res = await http.get(`/demos/${demoId}/players`, { signal });
  return res.data;
}

export async function getPositions(
  demoId: string,
  params: {
    round_number?: number;
    player_ids?: number[];
    tick_min?: number;
    tick_max?: number;
  } = {},
  signal?: AbortSignal,
): Promise<PlayerPosition[]> {
  const query: Record<string, string | number> = {};
  if (params.round_number !== undefined) query.round_number = params.round_number;
  if (params.player_ids?.length) query.player_ids = params.player_ids.join(',');
  if (params.tick_min !== undefined) query.tick_min = params.tick_min;
  if (params.tick_max !== undefined) query.tick_max = params.tick_max;

  const res = await http.get(`/demos/${demoId}/positions`, { params: query, signal });
  return res.data;
}

export async function getEvents(
  demoId: string,
  params: { round_number?: number; event_type?: string } = {},
  signal?: AbortSignal,
): Promise<GameEvent[]> {
  const res = await http.get(`/demos/${demoId}/events`, { params, signal });
  return res.data;
}

// ---------------------------------------------------------------------------
// Grenades
// ---------------------------------------------------------------------------

export async function getGrenades(
  demoId: string,
  params: { round_number?: number } = {},
  signal?: AbortSignal,
): Promise<GrenadeEvent[]> {
  const res = await http.get(`/demos/${demoId}/grenades`, { params, signal });
  return (res.data as Array<Record<string, unknown>>).map((g) => {
    const raw = g.trajectory;
    let trajectory: GrenadeEvent['trajectory'] = null;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        trajectory = JSON.parse(raw) as GrenadeEvent['trajectory'];
      } catch {
        trajectory = null;
      }
    } else if (Array.isArray(raw)) {
      trajectory = raw as GrenadeEvent['trajectory'];
    }
    return {
      ...(g as unknown as GrenadeEvent),
      trajectory,
    };
  });
}

// ---------------------------------------------------------------------------
// Player state events
// ---------------------------------------------------------------------------

export async function getPlayerStateEvents(
  demoId: string,
  params: { round_number?: number; player_ids?: number[] } = {},
  signal?: AbortSignal,
): Promise<PlayerStateEvent[]> {
  const query: Record<string, string | number> = {};
  if (params.round_number !== undefined) query.round_number = params.round_number;
  if (params.player_ids?.length) query.player_ids = params.player_ids.join(',');
  const res = await http.get(`/demos/${demoId}/player-state-events`, { params: query, signal });
  return res.data;
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

export async function generateHeatmap(
  demoId: string,
  payload: HeatmapPayload,
): Promise<HeatmapResult> {
  const res = await http.post(`/demos/${demoId}/heatmap`, payload);
  return res.data;
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export async function getMaps(): Promise<MapMeta[]> {
  const res = await http.get('/maps');
  return res.data;
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface VoiceClip {
  start_tick: number;
  audio_url: string;
}

export interface VoicePlayer {
  steamid: number;
  name: string;
  clips: VoiceClip[];
}

export interface VoiceManifest {
  round_number: number;
  start_tick: number;
  end_tick: number;
  tick_rate: number;
  available: boolean;
  players: VoicePlayer[];
}

export async function getVoiceManifest(
  demoId: string,
  roundNumber: number,
  extended = false,
): Promise<VoiceManifest> {
  const params: Record<string, string | number | boolean> = {
    round_number: roundNumber,
  };
  // Only send the flag when set so the non-extended cache path is unchanged.
  if (extended) params.extended = true;
  const res = await http.get(`/demos/${demoId}/voice`, { params });
  return res.data;
}

// ---------------------------------------------------------------------------
// Team sessions
// ---------------------------------------------------------------------------

import type {
  TeamSessionValidation,
  TeamSessionListItem,
  TeamSessionDetail,
  TeamSessionHeatmapPayload,
  HeatmapResult as _HeatmapResult,
  TeamInfo,
  TeamDetail,
} from '../types';

export async function validateTeamSession(
  demoIds: string[],
): Promise<TeamSessionValidation> {
  const res = await http.post('/team-sessions/validate', { demo_ids: demoIds });
  return res.data;
}

export async function createTeamSession(
  name: string,
  demoIds: string[],
): Promise<{ id: string; name: string; created_at: string }> {
  const res = await http.post('/team-sessions', { name, demo_ids: demoIds });
  return res.data;
}

export async function listTeamSessions(): Promise<TeamSessionListItem[]> {
  const res = await http.get('/team-sessions');
  return res.data;
}

export async function getTeamSession(id: string): Promise<TeamSessionDetail> {
  const res = await http.get(`/team-sessions/${id}`);
  return res.data;
}

export async function deleteTeamSession(id: string): Promise<void> {
  await http.delete(`/team-sessions/${id}`);
}

export async function generateTeamHeatmap(
  sessionId: string,
  payload: TeamSessionHeatmapPayload,
): Promise<_HeatmapResult> {
  const res = await http.post(`/team-sessions/${sessionId}/heatmap`, payload);
  return res.data;
}

// ---------------------------------------------------------------------------
// Team organizer (multi-map team management)
// ---------------------------------------------------------------------------

export async function listTeams(): Promise<TeamInfo[]> {
  const res = await http.get('/teams');
  return res.data;
}

export async function createTeam(name: string): Promise<TeamInfo> {
  const res = await http.post('/teams', { name });
  return res.data;
}

export async function getTeam(teamId: string): Promise<TeamDetail> {
  const res = await http.get(`/teams/${teamId}`);
  return res.data;
}

export async function deleteTeam(teamId: string): Promise<void> {
  await http.delete(`/teams/${teamId}`);
}

export async function addDemosToTeam(teamId: string, demoIds: string[]): Promise<void> {
  await http.post(`/teams/${teamId}/demos`, { demo_ids: demoIds });
}

export async function removeDemoFromTeam(teamId: string, demoId: string): Promise<void> {
  await http.delete(`/teams/${teamId}/demos/${demoId}`);
}

// ---------------------------------------------------------------------------
// FACEIT integration
// ---------------------------------------------------------------------------

import type {
  FaceitResolvedPlayer,
  FaceitCommonMatches,
  FaceitStackMapStats,
  FaceitLoadResult,
  FaceitConfig,
} from '../types';

export async function getFaceitConfig(): Promise<FaceitConfig> {
  const res = await http.get('/faceit/config');
  return res.data;
}

export async function saveFaceitApiKey(apiKey: string): Promise<FaceitConfig> {
  const res = await http.post('/faceit/config', { api_key: apiKey });
  return res.data;
}

export async function clearFaceitApiKey(): Promise<FaceitConfig> {
  const res = await http.delete('/faceit/config');
  return res.data;
}

export async function resolveFaceitNicknames(
  nicknames: string[],
): Promise<{ players: FaceitResolvedPlayer[] }> {
  const res = await http.post('/faceit/resolve', { nicknames });
  return res.data;
}

export async function findFaceitCommonMatches(
  playerIds: string[],
  opts: { same_team?: boolean; window?: number } = {},
): Promise<FaceitCommonMatches> {
  const res = await http.post('/faceit/common-matches', {
    player_ids: playerIds,
    same_team: opts.same_team ?? true,
    window: opts.window ?? 200,
  });
  return res.data;
}

export async function getFaceitStackMapStats(
  playerIds: string[],
  opts: { same_team?: boolean; window?: number; max_matches?: number } = {},
): Promise<FaceitStackMapStats> {
  const res = await http.post('/faceit/stack-map-stats', {
    player_ids: playerIds,
    same_team: opts.same_team ?? true,
    window: opts.window ?? 200,
    max_matches: opts.max_matches ?? 60,
  });
  return res.data;
}

export async function loadFaceitMatch(matchId: string): Promise<FaceitLoadResult> {
  const res = await http.post('/faceit/load-match', { match_id: matchId });
  return res.data;
}
