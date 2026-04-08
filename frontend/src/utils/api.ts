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

export async function getDemo(demoId: string): Promise<DemoMeta> {
  const res = await http.get(`/demos/${demoId}`);
  return res.data;
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

export async function getRounds(demoId: string): Promise<RoundInfo[]> {
  const res = await http.get(`/demos/${demoId}/rounds`);
  return res.data;
}

export async function getPlayers(demoId: string): Promise<PlayerInfo[]> {
  const res = await http.get(`/demos/${demoId}/players`);
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
): Promise<PlayerPosition[]> {
  const query: Record<string, string | number> = {};
  if (params.round_number !== undefined) query.round_number = params.round_number;
  if (params.player_ids?.length) query.player_ids = params.player_ids.join(',');
  if (params.tick_min !== undefined) query.tick_min = params.tick_min;
  if (params.tick_max !== undefined) query.tick_max = params.tick_max;

  const res = await http.get(`/demos/${demoId}/positions`, { params: query });
  return res.data;
}

export async function getEvents(
  demoId: string,
  params: { round_number?: number; event_type?: string } = {},
): Promise<GameEvent[]> {
  const res = await http.get(`/demos/${demoId}/events`, { params });
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
