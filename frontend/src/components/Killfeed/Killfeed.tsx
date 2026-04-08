/**
 * Killfeed — overlays the last N kills of the current round up to the current tick.
 *
 * Positioned in the top-right corner of the radar canvas via CSS absolute.
 * Each entry shows:  [attacker#] ──[weapon]──▶ [victim#]  (HS star if applicable)
 */

import React, { useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import styles from './Killfeed.module.css';

const MAX_ENTRIES = 6;

const WEAPON_ABBREV: Record<string, string> = {
  ak47: 'AK',
  m4a1: 'M4',
  m4a1_silencer: 'M4S',
  awp: 'AWP',
  deagle: 'DEG',
  glock: 'GLK',
  usp_silencer: 'USP',
  p250: 'P250',
  mp9: 'MP9',
  mac10: 'MAC',
  ump45: 'UMP',
  famas: 'FAM',
  galil: 'GAL',
  sg556: 'SG5',
  aug: 'AUG',
  ssg08: 'SSG',
  g3sg1: 'G3',
  scar20: 'SC2',
  p90: 'P90',
  bizon: 'BIZ',
  mp7: 'MP7',
  mp5sd: 'MP5',
  negev: 'NEG',
  m249: 'M249',
  nova: 'NOV',
  xm1014: 'XM',
  mag7: 'MAG',
  sawedoff: 'SAW',
  tec9: 'T9',
  cz75a: 'CZ',
  p2000: 'P2K',
  r8_revolver: 'R8',
  five_seven: '57',
  inferno: 'NADE',
  hegrenade: 'HE',
  flashbang: 'FLASH',
  smokegrenade: 'SMOKE',
  molotov: 'MOLO',
  world: 'FALL',
};

function weaponLabel(weapon: string | null): string {
  if (!weapon) return '?';
  const w = weapon.toLowerCase().replace('weapon_', '');
  return WEAPON_ABBREV[w] ?? w.slice(0, 5).toUpperCase();
}

const Killfeed: React.FC = () => {
  const events        = useAppStore((s) => s.events);
  const players       = useAppStore((s) => s.players);
  const activeRound   = useAppStore((s) => s.activeRound);
  const currentTick   = useAppStore((s) => s.currentTick);

  // Map player_id → 1-based index for display
  const playerNum = useMemo(() => {
    const map = new Map<number, number>();
    players.forEach((p, idx) => map.set(p.player_id, idx + 1));
    return map;
  }, [players]);

  const kills = useMemo(() => {
    return events
      .filter(
        (e) =>
          e.event_type === 'player_death' &&
          e.round_number === activeRound &&
          e.tick <= currentTick,
      )
      .slice(-MAX_ENTRIES);
  }, [events, activeRound, currentTick]);

  if (!kills.length) return null;

  return (
    <div className={styles.feed}>
      {kills.map((k) => {
        const attackerNum = k.attacker_id ? (playerNum.get(k.attacker_id) ?? '?') : '?';
        const victimNum   = playerNum.get(k.victim_id ?? 0) ?? '?';
        return (
          <div key={k.id} className={styles.entry}>
            <span className={styles.attacker}>#{attackerNum}</span>
            <span className={styles.weapon}>{weaponLabel(k.weapon)}</span>
            <span className={styles.victim}>#{victimNum}</span>
            {k.headshot === 1 && <span className={styles.hs} title="Headshot">★</span>}
          </div>
        );
      })}
    </div>
  );
};

export default Killfeed;
