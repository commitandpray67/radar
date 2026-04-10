import React, { useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import styles from './PlayerInfoPanel.module.css';

interface PlayerState {
  hp: number;
  armor: number;
  activeWeapon: string;
  pistols: Set<string>;
  primaries: Set<string>;
  grenades: Set<string>;
}

const GRENADE_WEAPONS = new Set([
  'weapon_hegrenade',
  'weapon_flashbang',
  'weapon_smokegrenade',
  'weapon_molotov',
  'weapon_incgrenade',
  'weapon_decoy',
]);

const PISTOL_WEAPONS = new Set([
  'weapon_glock',
  'weapon_hkp2000',
  'weapon_usp_silencer',
  'weapon_p250',
  'weapon_fiveseven',
  'weapon_cz75a',
  'weapon_deagle',
  'weapon_revolver',
  'weapon_tec9',
  'weapon_elite',
]);

const PRIMARY_HINTS = [
  'ak47', 'm4a1', 'm4a1_silencer', 'famas', 'galilar', 'aug', 'sg556',
  'awp', 'ssg08', 'scar20', 'g3sg1', 'xm1014', 'nova', 'mag7', 'sawedoff',
  'mp9', 'mac10', 'ump45', 'mp7', 'mp5sd', 'p90', 'bizon', 'm249', 'negev',
];

const ARMOR_ITEMS = new Set([
  'item_kevlar',
  'item_assaultsuit',
  'vest',
  'vesthelm',
  'kevlar',
]);

function formatWeapon(raw: string | null | undefined): string {
  if (!raw) return '—';
  return raw.replace(/^weapon_/, '').replace(/_/g, ' ');
}

function normalizeWeaponName(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.toLowerCase().trim();
  if (!s) return '';
  if (s.startsWith('weapon_') || s.startsWith('item_')) return s;
  return `weapon_${s}`;
}

function grenadeShortName(raw: string): string {
  const key = raw.replace(/^weapon_/, '');
  if (key === 'hegrenade') return 'HE';
  if (key === 'flashbang') return 'Flash';
  if (key === 'smokegrenade') return 'Smoke';
  if (key === 'molotov') return 'Molo';
  if (key === 'incgrenade') return 'Inc';
  if (key === 'decoy') return 'Decoy';
  return formatWeapon(raw);
}

function isPrimaryWeapon(raw: string): boolean {
  const key = raw.replace(/^weapon_/, '');
  return PRIMARY_HINTS.some((hint) => key.includes(hint));
}

function defaultPistolForTeam(team: 'CT' | 'T'): string {
  return team === 'CT' ? 'usp silencer / p2000' : 'glock';
}

const GRENADE_ICON_PATH: Record<string, string> = {
  weapon_hegrenade:    '/icons/he-grenade-icon.svg',
  weapon_flashbang:    '/icons/flashbang-icon.svg',
  weapon_smokegrenade: '/icons/smoke-grenade-icon.svg',
  weapon_molotov:      '/icons/molotov-icon.svg',
  weapon_incgrenade:   '/icons/incendiary-grenade-icon.svg',
  weapon_decoy:        '/icons/decoy-icon.svg',
};

const WEAPON_ICON_PATH: Record<string, string> = {
  // Pistols
  weapon_glock:         '/icons/glock-icon.svg',
  weapon_hkp2000:       '/icons/p2000-icon.svg',
  weapon_usp_silencer:  '/icons/usps-icon.svg',
  weapon_p250:          '/icons/p250-icon.svg',
  weapon_fiveseven:     '/icons/five-seven-icon.svg',
  weapon_cz75a:         '/icons/cz75a-icon.svg',
  weapon_deagle:        '/icons/deagle-icon.svg',
  weapon_revolver:      '/icons/revolver-icon.svg',
  weapon_tec9:          '/icons/tec9-icon.svg',
  weapon_elite:         '/icons/dual-elite-icon.svg',
  // Rifles
  weapon_ak47:          '/icons/ak47-icon.svg',
  weapon_m4a1:          '/icons/m4a4-icon.svg',
  weapon_m4a1_silencer: '/icons/m4a1-icon.svg',
  weapon_famas:         '/icons/famas-icon.svg',
  weapon_galilar:       '/icons/galilar-icon.svg',
  weapon_aug:           '/icons/aug-icon.svg',
  weapon_sg556:         '/icons/sg553-icon.svg',
  // Snipers
  weapon_awp:           '/icons/awp-icon.svg',
  weapon_ssg08:         '/icons/ssg08-icon.svg',
  weapon_scar20:        '/icons/scar20-icon.svg',
  weapon_g3sg1:         '/icons/g3sg1-icon.svg',
  // Shotguns
  weapon_xm1014:        '/icons/xm1014-icon.svg',
  weapon_nova:          '/icons/nova-icon.svg',
  weapon_mag7:          '/icons/mag7-icon.svg',
  weapon_sawedoff:      '/icons/sawed-off-icon.svg',
  // SMGs
  weapon_mp9:           '/icons/mp9-icon.svg',
  weapon_mac10:         '/icons/mac10-icon.svg',
  weapon_ump45:         '/icons/ump45-icon.svg',
  weapon_mp7:           '/icons/mp7-icon.svg',
  weapon_mp5sd:         '/icons/mp5sd-icon.svg',
  weapon_p90:           '/icons/p90-icon.svg',
  weapon_bizon:         '/icons/bizon-icon.svg',
  // Machine guns
  weapon_m249:          '/icons/m249-icon.svg',
  weapon_negev:         '/icons/negev-icon.svg',
  // Knife (fallback for all knife variants)
  weapon_knife:         '/icons/knife-icon.svg',
  weapon_knife_t:       '/icons/knife-icon.svg',
};

function weaponIcon(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = normalizeWeaponName(raw);
  // Exact match first; fall back to knife generic for any knife variant
  if (WEAPON_ICON_PATH[key]) return WEAPON_ICON_PATH[key];
  if (key.includes('knife') || key.includes('bayonet'))
    return '/icons/knife-icon.svg';
  return null;
}

const PlayerInfoPanel: React.FC = () => {
  const players = useAppStore((s) => s.players);
  const activeRound = useAppStore((s) => s.activeRound);
  const currentTick = useAppStore((s) => s.currentTick);
  const playerStateEvents = useAppStore((s) => s.playerStateEvents);
  const events = useAppStore((s) => s.events);
  const positions = useAppStore((s) => s.positions);

  const indexByPlayerId = useMemo(() => {
    const map = new Map<number, number>();
    players.forEach((p, idx) => map.set(p.player_id, idx + 1));
    return map;
  }, [players]);

  const teamByPlayerId = useMemo(() => {
    const map = new Map<number, 'CT' | 'T'>();
    if (activeRound === null) return map;

    const latestTickByPlayer = new Map<number, number>();
    for (const pos of positions) {
      if (pos.round_number !== activeRound || pos.tick > currentTick) continue;
      const prevTick = latestTickByPlayer.get(pos.player_id) ?? -1;
      if (pos.tick < prevTick) continue;
      latestTickByPlayer.set(pos.player_id, pos.tick);
      map.set(pos.player_id, pos.team_num === 3 ? 'CT' : 'T');
    }

    for (const p of players) {
      if (!map.has(p.player_id)) {
        map.set(p.player_id, p.initial_team === 'CT' ? 'CT' : 'T');
      }
    }

    return map;
  }, [players, positions, activeRound, currentTick]);

  const playerStates = useMemo<Map<number, PlayerState>>(() => {
    const state = new Map<number, PlayerState>();
    if (activeRound === null) return state;

    for (const p of players) {
      state.set(p.player_id, {
        hp: 100,
        armor: 0,
        activeWeapon: '',
        pistols: new Set<string>(),
        primaries: new Set<string>(),
        grenades: new Set<string>(),
      });
    }

    for (const ev of playerStateEvents) {
      if (ev.round_number !== activeRound || ev.tick > currentTick) continue;
      const cur = state.get(ev.player_id);
      if (!cur) continue;

      if (ev.event_type === 'spawn') {
        state.set(ev.player_id, {
          hp: ev.hp ?? 100,
          armor: ev.armor ?? cur.armor,
          activeWeapon: cur.activeWeapon,
          pistols: new Set(),
          primaries: new Set(),
          grenades: new Set(),
        });
        continue;
      }

      if (ev.event_type === 'hurt') {
        state.set(ev.player_id, {
          ...cur,
          hp: ev.hp ?? cur.hp,
          armor: ev.armor ?? cur.armor,
        });
        continue;
      }

      if (ev.event_type === 'equip') {
        const weapon = normalizeWeaponName(ev.weapon);
        const next: PlayerState = {
          ...cur,
          activeWeapon: weapon || cur.activeWeapon,
          pistols: new Set(cur.pistols),
          primaries: new Set(cur.primaries),
          grenades: new Set(cur.grenades),
        };

        if (ARMOR_ITEMS.has(weapon)) {
          next.armor = 100;
          state.set(ev.player_id, next);
          continue;
        }

        if (GRENADE_WEAPONS.has(weapon)) {
          next.grenades.add(weapon);
        } else if (PISTOL_WEAPONS.has(weapon)) {
          next.pistols.add(weapon);
        } else if (isPrimaryWeapon(weapon)) {
          next.primaries.add(weapon);
        }

        state.set(ev.player_id, next);
      }
    }

    return state;
  }, [players, activeRound, currentTick, playerStateEvents]);

  const deadSet = useMemo<Set<number>>(() => {
    const s = new Set<number>();
    if (activeRound === null) return s;
    for (const ev of events) {
      if (ev.round_number !== activeRound || ev.tick > currentTick) continue;
      if (ev.event_type === 'player_death' && ev.victim_id) {
        s.add(ev.victim_id);
      }
    }
    return s;
  }, [events, activeRound, currentTick]);

  const sortedPlayers = useMemo(() => {
    const ct = players.filter((p) => teamByPlayerId.get(p.player_id) === 'CT');
    const t = players.filter((p) => teamByPlayerId.get(p.player_id) === 'T');
    return { ct, t };
  }, [players, teamByPlayerId]);

  if (!players.length) {
    return <div className={styles.empty}>—</div>;
  }

  const renderPlayer = (p: typeof players[0]) => {
    const st = playerStates.get(p.player_id);
    if (!st) return null;

    const isAlive = !deadSet.has(p.player_id);
    const hp = isAlive ? st.hp : 0;
    const hpPct = Math.max(0, Math.min(100, hp));
    const hpColor = hpPct > 60 ? '#3a8a3a' : hpPct > 25 ? '#a08020' : '#8a2020';
    const team = teamByPlayerId.get(p.player_id) ?? (p.initial_team === 'CT' ? 'CT' : 'T');

    const pistolList = Array.from(st.pistols);
    const primaryList = Array.from(st.primaries);
    const pistol = pistolList.length
      ? formatWeapon(pistolList[pistolList.length - 1])
      : defaultPistolForTeam(team);
    const primary = primaryList.length ? formatWeapon(primaryList[primaryList.length - 1]) : '—';
    const grenades = Array.from(st.grenades.values());
    const armorPct = Math.max(0, Math.min(100, st.armor));

    return (
      <div key={p.player_id} className={`${styles.playerCard} ${!isAlive ? styles.dead : ''}`}>
        <div className={styles.rowTop}>
          <span className={`${styles.playerNum} ${team === 'CT' ? styles.numCT : styles.numT}`}>
            {indexByPlayerId.get(p.player_id) ?? '?'}
          </span>
          <span className={styles.playerName} title={p.name}>{p.name}</span>
          <span className={`${styles.sideBadge} ${team === 'CT' ? styles.badgeCT : styles.badgeT}`}>
            {team}
          </span>
        </div>

        <div className={styles.rowMid}>
          <div className={styles.barsWrap}>
            <div className={styles.hpBarWrap}>
              <div className={styles.hpBarFill} style={{ width: `${hpPct}%`, background: hpColor }} />
            </div>
            <div className={styles.armorBarWrap}>
              <div className={styles.armorBarFill} style={{ width: `${isAlive ? armorPct : 0}%` }} />
            </div>
          </div>
        </div>

        <div className={styles.rowBottom}>
          <span className={styles.loadoutItem}>
            <strong>Pistol:</strong>{' '}
            {isAlive
              ? (() => {
                  const src = pistolList.length
                    ? weaponIcon(pistolList[pistolList.length - 1])
                    : null;
                  return src
                    ? <img src={src} alt={pistol} className={styles.weaponIcon}
                           onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    : pistol;
                })()
              : '—'}
          </span>
          <span className={styles.loadoutItem}>
            <strong>Primary:</strong>{' '}
            {isAlive
              ? (() => {
                  const src = primaryList.length
                    ? weaponIcon(primaryList[primaryList.length - 1])
                    : null;
                  return src
                    ? <img src={src} alt={primary} className={styles.weaponIcon}
                           onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                    : primary;
                })()
              : '—'}
            <span className={styles.loadoutSep}> · </span>
            <strong>Nades:</strong>
            <span className={styles.nadesInline}>
              {isAlive && grenades.length > 0 ? grenades.map((nade) => (
                <span key={`${p.player_id}-${nade}`} className={styles.nadeChip} title={grenadeShortName(nade)}>
                  <img
                    src={GRENADE_ICON_PATH[nade]}
                    alt={grenadeShortName(nade)}
                    className={styles.nadeIcon}
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <span className={styles.nadeFallback}>{grenadeShortName(nade)}</span>
                </span>
              )) : ' —'}
            </span>
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.root}>
      {sortedPlayers.ct.length > 0 && (
        <div className={styles.teamSection}>
          <div className={styles.teamLabelCT}>CT</div>
          {sortedPlayers.ct.map((p) => renderPlayer(p))}
        </div>
      )}
      {sortedPlayers.t.length > 0 && (
        <div className={styles.teamSection}>
          <div className={styles.teamLabelT}>T</div>
          {sortedPlayers.t.map((p) => renderPlayer(p))}
        </div>
      )}
      {playerStateEvents.length === 0 && (
        <p className={styles.noData}>
          Re-upload the demo to enable live player stats.
        </p>
      )}
    </div>
  );
};

export default PlayerInfoPanel;
