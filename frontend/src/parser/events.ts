/**
 * Game events, economy, and player-state events —
 * TypeScript port of `backend/parser/_events.py`.
 */

import type { DemoSource, Row } from './source';
import type { ParsedGameEvent, ParsedRound, ParsedStateEvent } from './types';
import { buildRoundLookup, toInt } from './utils';
import { getCalibration } from '../data/mapCalibrations';

// ---------------------------------------------------------------------------
// Inventory display-name → weapon-token map (port of _INVENTORY_NAME_TO_TOKEN)
// ---------------------------------------------------------------------------
const INVENTORY_NAME_TO_TOKEN: Record<string, string> = {
  // Pistols
  glock18: 'glock', p2000: 'hkp2000', usps: 'usp_silencer', dualberettas: 'elite',
  p250: 'p250', tec9: 'tec9', fiveseven: 'fiveseven', cz75auto: 'cz75a',
  deserteagle: 'deagle', r8revolver: 'revolver',
  // SMGs
  mac10: 'mac10', mp9: 'mp9', mp7: 'mp7', mp5sd: 'mp5sd', ump45: 'ump45',
  p90: 'p90', ppbizon: 'bizon',
  // Rifles
  galilar: 'galilar', famas: 'famas', ak47: 'ak47', m4a4: 'm4a1',
  m4a1s: 'm4a1_silencer', sg553: 'sg556', aug: 'aug',
  // Snipers
  ssg08: 'ssg08', awp: 'awp', g3sg1: 'g3sg1', scar20: 'scar20',
  // Heavy
  nova: 'nova', xm1014: 'xm1014', sawedoff: 'sawedoff', mag7: 'mag7',
  m249: 'm249', negev: 'negev',
  // Grenades
  smokegrenade: 'smokegrenade', flashbang: 'flashbang',
  highexplosivegrenade: 'hegrenade', incendiarygrenade: 'incgrenade',
  molotov: 'molotov', decoygrenade: 'decoy',
};

export function inventoryItemToToken(name: unknown): string | null {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  // Classnames ("weapon_ak47"/"item_kevlar") pass through — the frontend
  // normaliser handles them.
  if (low.startsWith('weapon_') || low.startsWith('item_')) return low;
  const norm = low.replace(/[^a-z0-9]/g, '');
  return INVENTORY_NAME_TO_TOKEN[norm] ?? null;
}

// ---------------------------------------------------------------------------
// Kill + bomb events
// ---------------------------------------------------------------------------
export function extractEvents(
  source: DemoSource,
  rounds: ParsedRound[],
  mapName: string | null = null,
): ParsedGameEvent[] {
  const rn = buildRoundLookup(rounds);
  const events: ParsedGameEvent[] = [];

  // Kills
  try {
    const rows = source.parseEvent('player_death', [
      'tick', 'attacker_steamid', 'user_steamid', 'weapon', 'headshot',
    ]);
    for (const row of rows) {
      const tick = toInt(row.tick ?? 0);
      events.push({
        tick,
        round_number: rn(tick),
        event_type: 'player_death',
        attacker_id: toInt(row.attacker_steamid ?? 0) || null,
        victim_id: toInt(row.user_steamid ?? 0) || null,
        weapon: String(row.weapon ?? ''),
        headshot: row.headshot ? 1 : 0,
      });
    }
  } catch {
    /* kills unavailable */
  }

  // Bombsite centres for position-based A/B labelling.
  const cal = mapName ? getCalibration(mapName) : null;
  const siteA = cal?.bombsite_a ?? null;
  const siteB = cal?.bombsite_b ?? null;
  const classifySite = (ux: unknown, uy: unknown): 'A' | 'B' | null => {
    if (!siteA || !siteB) return null;
    const px = Number(ux);
    const py = Number(uy);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    const da = (px - siteA[0]) ** 2 + (py - siteA[1]) ** 2;
    const db = (px - siteB[0]) ** 2 + (py - siteB[1]) ** 2;
    return da <= db ? 'A' : 'B';
  };

  // Bomb events
  for (const name of ['bomb_planted', 'bomb_defused', 'bomb_exploded']) {
    try {
      const rows = name === 'bomb_planted'
        ? source.parseEvent(name, ['tick'], ['X', 'Y'])
        : source.parseEvent(name, ['tick']);
      for (const row of rows) {
        const tick = toInt(row.tick ?? 0);
        const weapon = name === 'bomb_planted'
          ? classifySite(row.user_X, row.user_Y)
          : null;
        events.push({
          tick,
          round_number: rn(tick),
          event_type: name,
          attacker_id: null,
          victim_id: null,
          weapon,
          headshot: 0,
        });
      }
    } catch {
      /* this bomb event unavailable */
    }
  }

  return events.sort((a, b) => a.tick - b.tick);
}

// ---------------------------------------------------------------------------
// Economy (equipment values at freeze_end)
// ---------------------------------------------------------------------------
export function extractEconomy(source: DemoSource, rounds: ParsedRound[]): void {
  if (rounds.length === 0) return;
  const freezeTicks = rounds.filter((r) => r.freeze_end_tick > 0).map((r) => r.freeze_end_tick);
  if (freezeTicks.length === 0) return;

  let rows: Row[];
  try {
    rows = source.parseTicks(['current_equip_value', 'team_num', 'steamid'], freezeTicks);
  } catch {
    return;
  }

  // tick → { team_num → total equip }
  const economy = new Map<number, { ct: number; t: number }>();
  for (const row of rows) {
    const tick = toInt(row.tick ?? 0);
    const team = toInt(row.team_num ?? 0);
    const val = toInt(row.current_equip_value ?? 0);
    if ((team === 2 || team === 3) && val > 0) {
      const acc = economy.get(tick) ?? { ct: 0, t: 0 };
      if (team === 3) acc.ct += val;
      else acc.t += val;
      economy.set(tick, acc);
    }
  }

  for (const r of rounds) {
    const snap = economy.get(r.freeze_end_tick);
    r.ct_equip_value = snap?.ct ?? 0;
    r.t_equip_value = snap?.t ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Player state events (hurt / equip / spawn)
// ---------------------------------------------------------------------------
function eventPlayerId(row: Row): number {
  for (const key of ['user_steamid', 'steamid', 'player_steamid']) {
    const pid = toInt(row[key] ?? 0, 0);
    if (pid > 0) return pid;
  }
  return 0;
}

function optionalNonNegInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.trunc(n));
}

function rowHp(row: Row, def: unknown = undefined): number | null {
  return optionalNonNegInt(row.hp ?? row.health ?? row.user_health ?? def);
}
function rowArmor(row: Row): number | null {
  return optionalNonNegInt(row.armor ?? row.armor_value ?? row.user_armor);
}

export function extractPlayerStateEvents(
  source: DemoSource,
  rounds: ParsedRound[],
  tickRate = 64.0,
): ParsedStateEvent[] {
  const rn = buildRoundLookup(rounds);
  const out: ParsedStateEvent[] = [];

  const pushEquip = (name: string, weaponKey: (row: Row) => string) => {
    try {
      const props = name === 'item_purchase'
        ? ['tick', 'user_steamid', 'weapon', 'item']
        : ['tick', 'user_steamid', 'item'];
      for (const row of source.parseEvent(name, props)) {
        const tick = toInt(row.tick ?? 0);
        const round = rn(tick);
        if (round === 0) continue;
        const pid = eventPlayerId(row);
        if (pid === 0) continue;
        const weapon = weaponKey(row);
        if (!weapon) continue;
        out.push({ tick, round_number: round, player_id: pid, event_type: 'equip', hp: null, armor: null, weapon });
      }
    } catch {
      /* event unavailable */
    }
  };

  // player_hurt
  try {
    for (const row of source.parseEvent('player_hurt', ['tick', 'user_steamid', 'hp', 'armor', 'weapon'])) {
      const tick = toInt(row.tick ?? 0);
      const round = rn(tick);
      if (round === 0) continue;
      const pid = eventPlayerId(row);
      if (pid === 0) continue;
      out.push({ tick, round_number: round, player_id: pid, event_type: 'hurt', hp: rowHp(row), armor: rowArmor(row), weapon: String(row.weapon ?? '') });
    }
  } catch {
    /* hurt unavailable */
  }

  pushEquip('item_equip', (row) => String(row.item ?? ''));
  pushEquip('item_pickup', (row) => String(row.item ?? ''));
  pushEquip('item_purchase', (row) => String(row.weapon ?? row.item ?? ''));

  // player_spawn
  try {
    for (const row of source.parseEvent('player_spawn', ['tick', 'user_steamid', 'health', 'hp', 'armor', 'armor_value'])) {
      const tick = toInt(row.tick ?? 0);
      const round = rn(tick);
      if (round === 0) continue;
      const pid = eventPlayerId(row);
      if (pid === 0) continue;
      out.push({ tick, round_number: round, player_id: pid, event_type: 'spawn', hp: rowHp(row, 100), armor: rowArmor(row), weapon: null });
    }
  } catch {
    /* spawn unavailable */
  }

  // freeze_end tick fallback (true round-start HP/armor)
  try {
    const freezeTicks = [...new Set(rounds.map((r) => r.freeze_end_tick))].sort((a, b) => a - b);
    if (freezeTicks.length > 0) {
      for (const row of source.parseTicks(['steamid', 'health', 'hp', 'armor', 'armor_value'], freezeTicks)) {
        const tick = toInt(row.tick ?? 0);
        const round = rn(tick);
        if (round === 0) continue;
        const pid = eventPlayerId(row);
        if (pid === 0) continue;
        const hp = rowHp(row);
        const armor = rowArmor(row);
        if (hp === null && armor === null) continue;
        out.push({ tick, round_number: round, player_id: pid, event_type: 'spawn', hp, armor, weapon: null });
      }
    }
  } catch {
    /* freeze-end state unavailable */
  }

  // Inventory prop sampling (robust weapon source when item_* events are absent)
  try {
    const step = Math.max(64, Math.round(tickRate * 5));
    const invTickToRound = new Map<number, number>();
    for (const r of rounds) {
      let t = Math.max(r.start_tick, r.freeze_end_tick);
      while (t <= r.end_tick) {
        if (!invTickToRound.has(t)) invTickToRound.set(t, r.round_number);
        t += step;
      }
    }
    const invTicks = [...invTickToRound.keys()].sort((a, b) => a - b);
    if (invTicks.length > 0) {
      const rows = source.parseTicks(['steamid', 'inventory'], invTicks)
        .slice()
        .sort((a, b) => toInt(a.tick ?? 0) - toInt(b.tick ?? 0));
      const seen = new Set<string>();
      for (const row of rows) {
        const tick = toInt(row.tick ?? 0);
        const round = invTickToRound.get(tick) ?? rn(tick);
        if (!round) continue;
        const pid = eventPlayerId(row);
        if (pid === 0) continue;
        const inventory = row.inventory;
        if (!Array.isArray(inventory)) continue;
        for (const item of inventory) {
          const token = inventoryItemToToken(item);
          if (token === null) continue;
          const key = `${round}:${pid}:${token}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ tick, round_number: round, player_id: pid, event_type: 'equip', hp: null, armor: null, weapon: token });
        }
      }
    }
  } catch {
    /* inventory sampling unavailable */
  }

  return out.sort((a, b) => a.tick - b.tick);
}
