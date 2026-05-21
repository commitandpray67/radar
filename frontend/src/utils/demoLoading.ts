/**
 * Shared demo-loading routine.
 *
 * Used by both the single-demo loader and team-session demo switcher.
 * Fetches rounds/players/events/grenades/state-events for a demo and writes
 * them into the standard store slots.
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

export async function loadDemoIntoStore(
  demoId: string,
  opts: LoadOptions,
): Promise<void> {
  const [rounds, players, events, grenades, playerStateEvts] = await Promise.all([
    getRounds(demoId),
    getPlayers(demoId),
    getEvents(demoId),
    getGrenades(demoId),
    getPlayerStateEvents(demoId),
  ]);

  const store = useAppStore.getState();
  store.setRounds(rounds);
  store.setPlayers(players);
  store.setEvents(events);
  store.setGrenades(grenades);
  store.setPlayerStateEvents(playerStateEvts);

  const freshDemo = await getDemo(demoId);
  store.setDemo(freshDemo);

  const mapMeta = opts.maps.find((m) => m.name === freshDemo.map_name) ?? null;
  store.setCurrentMap(mapMeta);

  if ((opts.jumpToFirstRound ?? true) && rounds.length > 0) {
    store.setActiveRound(rounds[0].round_number);
  }
}
