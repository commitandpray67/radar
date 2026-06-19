/**
 * Shared demo-loading routine.
 *
 * Used by both the single-demo loader and team-session demo switcher.
 * Fetches rounds/players/events/grenades/state-events for a demo and writes
 * them into the standard store slots.
 *
 * Concurrency: rapidly switching demos (clicking B while A is still loading)
 * must never let the slower request win and leave the store showing a mix of
 * two demos. We guard with a monotonic load token — only the most recent call
 * writes to the store — and abort the previous call's in-flight requests.
 */

import {
  getRounds,
  getPlayers,
  getEvents,
  getGrenades,
  getPlayerStateEvents,
  getDemo,
} from './api';
import { useAppStore } from '../store/demoStore';
import type { MapMeta } from '../types';

interface LoadOptions {
  /** Existing maps array; if non-empty, skip refetching maps. */
  maps: MapMeta[];
  /** Jump to round 1 after load (default true). */
  jumpToFirstRound?: boolean;
}

let _loadToken = 0;
let _activeController: AbortController | null = null;

/** True if `err` is an axios/fetch cancellation rather than a real failure. */
function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  const code = (err as { code?: string })?.code;
  return name === 'CanceledError' || name === 'AbortError' || code === 'ERR_CANCELED';
}

export async function loadDemoIntoStore(
  demoId: string,
  opts: LoadOptions,
): Promise<void> {
  // Claim the latest token and cancel any previous in-flight load.
  const myToken = ++_loadToken;
  _activeController?.abort();
  const controller = new AbortController();
  _activeController = controller;
  const { signal } = controller;
  const isCurrent = () => myToken === _loadToken;

  try {
    const [rounds, players, events, grenades, playerStateEvts] = await Promise.all([
      getRounds(demoId, signal),
      getPlayers(demoId, signal),
      getEvents(demoId, {}, signal),
      getGrenades(demoId, {}, signal),
      getPlayerStateEvents(demoId, {}, signal),
    ]);

    // A newer load superseded us while these requests were in flight — bail
    // before touching the store so we never overwrite fresher data.
    if (!isCurrent()) return;

    const store = useAppStore.getState();
    store.setRounds(rounds);
    store.setPlayers(players);
    store.setEvents(events);
    store.setGrenades(grenades);
    store.setPlayerStateEvents(playerStateEvts);

    const freshDemo = await getDemo(demoId, signal);
    if (!isCurrent()) return;
    store.setDemo(freshDemo);

    const mapMeta = opts.maps.find((m) => m.name === freshDemo.map_name) ?? null;
    store.setCurrentMap(mapMeta);

    if ((opts.jumpToFirstRound ?? true) && rounds.length > 0) {
      store.setActiveRound(rounds[0].round_number);
    }
  } catch (err) {
    // Swallow cancellations from a superseding load; re-throw real errors.
    if (isAbortError(err) || signal.aborted) return;
    throw err;
  } finally {
    if (_activeController === controller) _activeController = null;
  }
}
