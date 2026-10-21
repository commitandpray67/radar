/**
 * highlights — helpers for the cross-demo player highlight search.
 *
 * Pure label/seek helpers (unit-tested) plus `openHighlight`, which swaps the
 * loaded demo if needed and drops the playhead just before the first kill.
 */

import type { Highlight, HighlightSearchPayload, HighlightSearchResult } from '../types';
import { useAppStore } from '../store/demoStore';
import { isDemoLoadPending, loadDemoIntoStore } from './demoLoading';
import { getMaps, searchHighlights } from './api';

/** Weapons offered in the filter, grouped, as [player_death token, label]. */
export const HIGHLIGHT_WEAPON_GROUPS: ReadonlyArray<{
  group: string;
  weapons: ReadonlyArray<readonly [string, string]>;
}> = [
  {
    group: 'Pistols',
    weapons: [
      ['deagle', 'Desert Eagle'],
      ['revolver', 'R8 Revolver'],
      ['usp_silencer', 'USP-S'],
      ['hkp2000', 'P2000'],
      ['glock', 'Glock-18'],
      ['p250', 'P250'],
      ['fiveseven', 'Five-SeveN'],
      ['tec9', 'Tec-9'],
      ['cz75a', 'CZ75-Auto'],
      ['elite', 'Dual Berettas'],
    ],
  },
  {
    group: 'Rifles',
    weapons: [
      ['ak47', 'AK-47'],
      ['m4a1', 'M4A4'],
      ['m4a1_silencer', 'M4A1-S'],
      ['galilar', 'Galil AR'],
      ['famas', 'FAMAS'],
      ['aug', 'AUG'],
      ['sg556', 'SG 553'],
    ],
  },
  {
    group: 'Snipers',
    weapons: [
      ['awp', 'AWP'],
      ['ssg08', 'SSG 08'],
      ['scar20', 'SCAR-20'],
      ['g3sg1', 'G3SG1'],
    ],
  },
  {
    group: 'SMGs',
    weapons: [
      ['mac10', 'MAC-10'],
      ['mp9', 'MP9'],
      ['mp7', 'MP7'],
      ['mp5sd', 'MP5-SD'],
      ['ump45', 'UMP-45'],
      ['p90', 'P90'],
      ['bizon', 'PP-Bizon'],
    ],
  },
  {
    group: 'Heavy',
    weapons: [
      ['nova', 'Nova'],
      ['xm1014', 'XM1014'],
      ['mag7', 'MAG-7'],
      ['sawedoff', 'Sawed-Off'],
      ['m249', 'M249'],
      ['negev', 'Negev'],
    ],
  },
  {
    group: 'Other',
    weapons: [
      ['knife', 'Knife'],
      ['taser', 'Zeus x27'],
      ['hegrenade', 'HE Grenade'],
      ['inferno', 'Molotov / Incendiary'],
    ],
  },
];

const WEAPON_LABEL = new Map(HIGHLIGHT_WEAPON_GROUPS.flatMap((g) => g.weapons));

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

/** "Desert Eagle / AWP" — or "any weapon" when no filter is set. */
export function weaponsText(tokens: string[]): string {
  return tokens.length ? tokens.map(weaponLabel).join(' / ') : 'any weapon';
}

/** "2 Desert Eagle + 1 AK-47" — the weapons used for a highlight's kills. */
export function killBreakdown(h: Highlight): string {
  const counts = new Map<string, number>();
  for (const k of h.kill_list) counts.set(k.weapon, (counts.get(k.weapon) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${n} ${weaponLabel(w)}`)
    .join(' + ');
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

let _openToken = 0;

/**
 * Load `demoId` (unless already loaded), jump to the highlight's round, seek
 * just before its first kill and select the player so they stand out.
 *
 * Only the most recent call wins: clicking another highlight while a demo is
 * still loading makes the earlier call bail out. Resolves true once opened.
 */
export async function openHighlight(
  demoId: string,
  h: Highlight,
  playerIds: string[],
): Promise<boolean> {
  const myToken = ++_openToken;
  const isCurrent = () => myToken === _openToken;
  let store = useAppStore.getState();
  // Also (re)load when some other demo's load is still in flight: it would
  // otherwise land after us and replace the demo we are about to show.
  const swapping = store.demo?.id !== demoId || isDemoLoadPending();

  // A highlight is a plain single-round replay: leave heatmap / multi-round /
  // utility views first (they hide normal playback), so no frame renders the
  // new demo in a stale mode.
  store.setHeatmapMode(false);
  store.setHeatmapResult(null);
  store.setHeatmapError(null);
  store.setMultiRoundMode(false);
  store.setUtilityMode(false);

  if (swapping) {
    // Round selections are per-demo round numbers — meaningless in another demo.
    store.setMultiRoundRounds([]);
    store.setHeatmapRounds([]);
    let maps = store.maps;
    if (maps.length === 0) {
      maps = await getMaps();
      if (!isCurrent()) return false;
      store.setMaps(maps);
    }
    // Highlights are single-demo views — leave any team session behind.
    store.setTeamSession(null);
    store.setActiveDemoId(null);
    await loadDemoIntoStore(demoId, { maps, jumpToFirstRound: false });
    store = useAppStore.getState();
    if (!isCurrent() || store.demo?.id !== demoId) return false; // superseded
  }

  store.setActiveRound(h.round_number);
  const round = store.rounds.find((r) => r.round_number === h.round_number);
  const tickRate = store.demo?.tick_rate ?? 64;
  store.setCurrentTick(highlightSeekTick(round?.start_tick ?? 0, h.first_kill_tick, tickRate));

  // Select exactly the player who made this highlight (a name can match more
  // than one SteamID). Compare as strings: SteamID64s exceed 2^53.
  const ids = new Set(h.player_id ? [h.player_id] : playerIds);
  const selected = store.players
    .filter((p) => ids.has(p.player_id_str ?? String(p.player_id)))
    .map((p) => p.player_id);
  if (selected.length) store.setSelectedPlayers(selected);
  return true;
}

/** Demo ids per /api/highlights request (the endpoint's cap). */
export const HIGHLIGHT_BATCH_SIZE = 200;

/**
 * Search any number of demos by splitting them into requests of at most
 * HIGHLIGHT_BATCH_SIZE and merging the results in order.
 */
export async function searchInChunks(
  payload: HighlightSearchPayload,
  search: (p: HighlightSearchPayload) => Promise<HighlightSearchResult> = searchHighlights,
  size = HIGHLIGHT_BATCH_SIZE,
): Promise<HighlightSearchResult> {
  const ids = payload.demo_ids;
  let merged = await search({ ...payload, demo_ids: ids.slice(0, size) });
  for (let i = size; i < ids.length; i += size) {
    const part = await search({ ...payload, demo_ids: ids.slice(i, i + size) });
    merged = { ...merged, total: merged.total + part.total, demos: [...merged.demos, ...part.demos] };
  }
  return merged;
}

/** Human-readable message from an axios/FastAPI error (422 detail is an array). */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((d) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((x: unknown) => x !== 'body').join('.') : '';
        return loc ? `${loc}: ${d?.msg ?? 'invalid'}` : String(d?.msg ?? d);
      })
      .join('; ');
  }
  return (err as Error)?.message || fallback;
}
