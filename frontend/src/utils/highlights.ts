/**
 * highlights — helpers for the cross-demo player highlight search.
 *
 * Pure label/seek helpers (unit-tested) plus `openHighlight`, which swaps the
 * loaded demo if needed and drops the playhead just before the first kill.
 */

import type { Highlight, HighlightSearchResult } from '../types';
import { useAppStore } from '../store/demoStore';
import { loadDemoIntoStore } from './demoLoading';
import { getMaps } from './api';

/** Weapons offered in the filter, as [backend token, label]. '' = any weapon. */
export const HIGHLIGHT_WEAPONS: ReadonlyArray<readonly [string, string]> = [
  ['', 'Any weapon'],
  ['deagle', 'Desert Eagle'],
  ['awp', 'AWP'],
  ['ak47', 'AK-47'],
  ['m4a1', 'M4A4'],
  ['m4a1_silencer', 'M4A1-S'],
  ['ssg08', 'SSG 08'],
  ['usp_silencer', 'USP-S'],
  ['glock', 'Glock-18'],
  ['hkp2000', 'P2000'],
  ['p250', 'P250'],
  ['fiveseven', 'Five-SeveN'],
  ['tec9', 'Tec-9'],
  ['cz75a', 'CZ75-Auto'],
  ['revolver', 'R8 Revolver'],
  ['elite', 'Dual Berettas'],
  ['galilar', 'Galil AR'],
  ['famas', 'FAMAS'],
  ['aug', 'AUG'],
  ['sg556', 'SG 553'],
  ['mac10', 'MAC-10'],
  ['mp9', 'MP9'],
  ['ump45', 'UMP-45'],
  ['p90', 'P90'],
  ['xm1014', 'XM1014'],
  ['nova', 'Nova'],
  ['mag7', 'MAG-7'],
  ['knife', 'Knife'],
];

const WEAPON_LABEL = new Map(HIGHLIGHT_WEAPONS.filter(([t]) => t));

export function weaponLabel(token: string): string {
  return WEAPON_LABEL.get(token) ?? token;
}

/** "3K", "4K", "ACE" (5+). */
export function killLabel(kills: number): string {
  return kills >= 5 ? 'ACE' : `${kills}K`;
}

/** Seconds of lead-in before the first kill when opening a highlight. */
export const HIGHLIGHT_LEAD_SECONDS = 4;

/** Tick to seek to: a few seconds before the first kill, never before round start. */
export function highlightSeekTick(
  roundStartTick: number,
  firstKillTick: number,
  tickRate: number,
  leadSeconds = HIGHLIGHT_LEAD_SECONDS,
): number {
  return Math.max(roundStartTick, Math.round(firstKillTick - leadSeconds * (tickRate || 64)));
}

/** Count highlights by tier ("3K" / "4K" / "ACE") across the whole search. */
export function countByTier(result: HighlightSearchResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of result.demos) {
    for (const h of d.highlights) {
      const k = killLabel(h.kills);
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Load `demoId` (unless already loaded), jump to the highlight's round, seek
 * just before its first kill and select the player so they stand out.
 */
export async function openHighlight(
  demoId: string,
  h: Highlight,
  playerIds: string[],
): Promise<void> {
  let store = useAppStore.getState();
  if (store.demo?.id !== demoId) {
    let maps = store.maps;
    if (maps.length === 0) {
      maps = await getMaps();
      store.setMaps(maps);
    }
    // Highlights are single-demo views — leave any team session behind.
    store.setTeamSession(null);
    store.setActiveDemoId(null);
    await loadDemoIntoStore(demoId, { maps, jumpToFirstRound: false });
    store = useAppStore.getState();
    if (store.demo?.id !== demoId) return; // superseded by a newer load
  }

  store.setActiveRound(h.round_number);
  const round = store.rounds.find((r) => r.round_number === h.round_number);
  const tickRate = store.demo?.tick_rate ?? 64;
  store.setCurrentTick(highlightSeekTick(round?.start_tick ?? 0, h.first_kill_tick, tickRate));

  const ids = new Set(playerIds);
  const selected = store.players
    .filter((p) => ids.has(p.player_id_str ?? String(p.player_id)))
    .map((p) => p.player_id);
  if (selected.length) store.setSelectedPlayers(selected);
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Used to parse a batch
 * of demos without flooding the backend's (2-worker) parse pool.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}
