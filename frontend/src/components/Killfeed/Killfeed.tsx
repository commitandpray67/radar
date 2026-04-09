/**
 * Killfeed — overlays the last N kills of the current round up to the current tick.
 *
 * Positioned in the top-right corner of the radar canvas via CSS absolute.
 * Each entry shows:  [attacker name] ──[weapon]──▶ [victim name]  (HS star if applicable)
 */

import React, { useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import { TEAM_COLORS } from '../../types';
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
  const rounds        = useAppStore((s) => s.rounds);
  const activeRound   = useAppStore((s) => s.activeRound);
  const currentTick   = useAppStore((s) => s.currentTick);
  const positions     = useAppStore((s) => s.positions);

  // Map player_id → nickname for display
  const playerName = useMemo(() => {
    const map = new Map<number, string>();
    players.forEach((p) => map.set(p.player_id, p.name));
    return map;
  }, [players]);

  // Use tick range rather than round_number so kills show correctly even when
  // event.round_number is 0 (stale cache from an old broken parse).
  const roundInfo = useMemo(
    () => rounds.find((r) => r.round_number === activeRound),
    [rounds, activeRound],
  );

  const kills = useMemo(() => {
    if (!roundInfo) return [];
    const { start_tick, end_tick } = roundInfo;
    return events
      .filter(
        (e) =>
          e.event_type === 'player_death' &&
          e.tick >= start_tick &&
          e.tick <= Math.min(end_tick, currentTick),
      )
      .slice(-MAX_ENTRIES);
  }, [events, roundInfo, currentTick]);

  // For color correctness after side swaps, infer each player's side at kill tick.
  const roundPositionsByPlayer = useMemo(() => {
    const byPlayer = new Map<number, Array<{ tick: number; team_num: number }>>();
    if (!roundInfo) return byPlayer;
    for (const pos of positions) {
      if (pos.round_number !== roundInfo.round_number) continue;
      const list = byPlayer.get(pos.player_id) ?? [];
      list.push({ tick: pos.tick, team_num: pos.team_num });
      byPlayer.set(pos.player_id, list);
    }
    for (const list of byPlayer.values()) {
      list.sort((a, b) => a.tick - b.tick);
    }
    return byPlayer;
  }, [positions, roundInfo]);

  const teamAtTick = (playerId: number | null, tick: number): 'CT' | 'T' | null => {
    if (!playerId) return null;
    const samples = roundPositionsByPlayer.get(playerId);
    if (!samples || samples.length === 0) return null;
    let latest: { tick: number; team_num: number } | null = null;
    for (const sample of samples) {
      if (sample.tick > tick) break;
      latest = sample;
    }
    if (!latest) return null;
    return latest.team_num === 3 ? 'CT' : 'T';
  };

  if (!kills.length) return null;

  return (
    <div className={styles.feed}>
      {kills.map((k) => {
        const attacker = k.attacker_id ? (playerName.get(k.attacker_id) ?? '?') : '?';
        const victim   = playerName.get(k.victim_id ?? 0) ?? '?';
        const attackerTeam = teamAtTick(k.attacker_id, k.tick);
        const victimTeam = teamAtTick(k.victim_id, k.tick);
        const attackerColor = attackerTeam === 'CT'
          ? TEAM_COLORS.CT
          : attackerTeam === 'T'
            ? TEAM_COLORS.T
            : '#9aa8b6';
        const victimColor = victimTeam === 'CT'
          ? TEAM_COLORS.CT
          : victimTeam === 'T'
            ? TEAM_COLORS.T
            : '#9aa8b6';
        return (
          <div key={k.id} className={styles.entry}>
            <span className={styles.attacker} style={{ color: attackerColor }} title={attacker}>{attacker}</span>
            <span className={styles.weapon}>{weaponLabel(k.weapon)}</span>
            <span className={styles.victim} style={{ color: victimColor }} title={victim}>{victim}</span>
            {k.headshot === 1 && <span className={styles.hs} title="Headshot">★</span>}
          </div>
        );
      })}
    </div>
  );
};

export default Killfeed;
