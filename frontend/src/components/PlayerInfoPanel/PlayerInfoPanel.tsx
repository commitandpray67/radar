import React, { useMemo, useState } from 'react';
import { useAppStore } from '../../store/demoStore';
import { useVoiceLines } from '../../hooks/useVoiceLines';
import { GRENADE_ICON_PATH, weaponIconSrc } from '../../utils/weaponIcons';
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

// All normalized armor item names that normalizeWeaponName() can produce.
// Raw names without a known prefix (e.g. 'kevlar') become 'weapon_kevlar'
// after normalization, so we list both item_ and weapon_ variants.
const ARMOR_ITEMS = new Set([
  'item_kevlar',
  'item_assaultsuit',
  'weapon_kevlar',
  'weapon_assaultsuit',
  'weapon_vest',
  'weapon_vesthelm',
]);

function formatWeapon(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '—';
  return raw.replace(/^weapon_/, '').replace(/_/g, ' ');
}

function normalizeWeaponName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
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

/** Renders a weapon icon; falls back to text label if image fails to load. */
function WeaponImg({ weaponKey, label }: { weaponKey: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const src = weaponIconSrc(weaponKey);
  if (!src || failed) return <>{label}</>;
  return (
    <img
      src={src}
      alt={label}
      className={styles.weaponIcon}
      onError={() => setFailed(true)}
    />
  );
}

/** Renders a grenade icon; falls back to short name text if image fails. */
function GrenadeImg({ nade }: { nade: string }) {
  const [failed, setFailed] = useState(false);
  const shortName = grenadeShortName(nade);
  const src = GRENADE_ICON_PATH[nade];
  if (!src || failed) return <span>{shortName}</span>;
  return (
    <img
      src={src}
      alt={shortName}
      className={styles.nadeIcon}
      onError={() => setFailed(true)}
    />
  );
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const PlayerInfoPanel: React.FC = () => {
  const players = useAppStore((s) => s.players);
  const activeRound = useAppStore((s) => s.activeRound);
  const currentTick = useAppStore((s) => s.currentTick);
  const playerStateEvents = useAppStore((s) => s.playerStateEvents);
  const events = useAppStore((s) => s.events);
  const positions = useAppStore((s) => s.positions);
  const rounds = useAppStore((s) => s.rounds);
  const isMultiRoundMode = useAppStore((s) => s.isMultiRoundMode);
  const isHeatmapMode    = useAppStore((s) => s.isHeatmapMode);

  // Voice / mute state
  const mutedPlayerIds   = useAppStore((s) => s.mutedPlayerIds);
  const toggleMutePlayer = useAppStore((s) => s.toggleMutePlayer);
  const muteTeam         = useAppStore((s) => s.muteTeam);
  const muteAll          = useAppStore((s) => s.muteAll);
  const unmuteAll        = useAppStore((s) => s.unmuteAll);

  const { voiceAvailable, voiceLoading, voiceError, speakingPlayerIds } = useVoiceLines();
  const isSingleRound = !isMultiRoundMode && !isHeatmapMode && activeRound !== null;

  const indexByPlayerId = useMemo(() => {
    const map = new Map<number, number>();
    players.forEach((p, idx) => map.set(p.player_id, idx + 1));
    return map;
  }, [players]);

  const teamByPlayerId = useMemo(() => {
    const map = new Map<number, 'CT' | 'T'>();
    if (activeRound === null) return map;

    // Scan only the live phase of this round (tick >= freeze_end_tick).
    // We do NOT cap at currentTick: team assignment is constant within a
    // round, so any live-phase record is authoritative regardless of where
    // the slider sits.  Using only live-phase records avoids stale team_num
    // values the CS2 engine hasn't updated yet during freeze time.  Not
    // capping at currentTick also fixes OT: a player whose first live-phase
    // record arrives after freeze_end_tick (reconnect, etc.) would otherwise
    // fall through to the initial_team fallback, which is only correct for
    // the first half.
    const roundInfo = rounds.find((r) => r.round_number === activeRound);
    const freezeEnd = roundInfo?.freeze_end_tick ?? 0;

    const latestTickByPlayer = new Map<number, number>();
    for (const pos of positions) {
      if (pos.round_number !== activeRound || pos.tick < freezeEnd) continue;
      const prevTick = latestTickByPlayer.get(pos.player_id) ?? -1;
      if (pos.tick <= prevTick) continue;
      latestTickByPlayer.set(pos.player_id, pos.tick);
      map.set(pos.player_id, pos.team_num === 3 ? 'CT' : 'T');
    }

    for (const p of players) {
      if (!map.has(p.player_id)) {
        map.set(p.player_id, p.initial_team === 'CT' ? 'CT' : 'T');
      }
    }

    return map;
  }, [players, positions, activeRound, rounds]);

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
          hp: safeNumber(ev.hp, 100),
          armor: safeNumber(ev.armor, cur.armor),
          activeWeapon: cur.activeWeapon,
          pistols: new Set(cur.pistols),
          primaries: new Set(cur.primaries),
          grenades: new Set(cur.grenades),
        });
        continue;
      }

      if (ev.event_type === 'hurt') {
        state.set(ev.player_id, {
          ...cur,
          hp: safeNumber(ev.hp, cur.hp),
          armor: safeNumber(ev.armor, cur.armor),
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
    // Use the detected pistol, or fall back to team default (glock / usp)
    const pistolKey = pistolList.length
      ? pistolList[pistolList.length - 1]
      : (team === 'T' ? 'weapon_glock' : 'weapon_usp_silencer');
    const pistolLabel = pistolList.length
      ? formatWeapon(pistolList[pistolList.length - 1])
      : (team === 'CT' ? 'usp / p2000' : 'glock');
    const primaryKey = primaryList.length ? primaryList[primaryList.length - 1] : null;
    const primaryLabel = primaryKey ? formatWeapon(primaryKey) : '—';
    const grenades = Array.from(st.grenades.values());
    const armorPct = Math.max(0, Math.min(100, st.armor));

    const isMuted = mutedPlayerIds.has(p.player_id);
    const isSpeaking = speakingPlayerIds.has(p.player_id);

    return (
      <div key={p.player_id} className={[styles.playerCard, !isAlive ? styles.dead : '', isSpeaking ? styles.speaking : ''].filter(Boolean).join(' ')}>
        <div className={styles.rowTop}>
          <span className={`${styles.playerNum} ${team === 'CT' ? styles.numCT : styles.numT}`}>
            {indexByPlayerId.get(p.player_id) ?? '?'}
          </span>
          <span className={styles.playerName} title={p.name}>{p.name}</span>
          <span className={`${styles.sideBadge} ${team === 'CT' ? styles.badgeCT : styles.badgeT}`}>
            {team}
          </span>
          {isSingleRound && (
            <button
              className={`${styles.muteBtn} ${isMuted ? styles.muted : ''}`}
              onClick={() => toggleMutePlayer(p.player_id)}
              title={isMuted ? 'Unmute player' : 'Mute player'}
            >
              {isMuted ? '🔇' : '🔊'}
            </button>
          )}
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
          <strong className={styles.loadoutLabel}>Pistol:</strong>
          {isAlive ? <WeaponImg weaponKey={pistolKey} label={pistolLabel} /> : <span className={styles.loadoutDash}>—</span>}
          <span className={styles.loadoutSep}>·</span>
          <strong className={styles.loadoutLabel}>Primary:</strong>
          {isAlive
            ? (primaryKey ? <WeaponImg weaponKey={primaryKey} label={primaryLabel} /> : <span className={styles.loadoutDash}>—</span>)
            : <span className={styles.loadoutDash}>—</span>}
          <span className={styles.loadoutSep}>·</span>
          <strong className={styles.loadoutLabel}>Nades:</strong>
          <span className={styles.nadesInline}>
            {isAlive && grenades.length > 0 ? grenades.map((nade) => (
              <span key={`${p.player_id}-${nade}`} className={styles.nadeChip} title={grenadeShortName(nade)}>
                <GrenadeImg nade={nade} />
              </span>
            )) : <span className={styles.loadoutDash}>—</span>}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.root}>

      {/* ── Voice control bar (single-round mode only) ── */}
      {isSingleRound && (
        <div className={styles.voiceBar}>
          <div className={styles.voiceBarRow}>
            <span className={styles.voiceLabel}>Voice</span>
            {voiceLoading && (
              <span className={styles.voiceStatus}>Loading…</span>
            )}
            {!voiceLoading && voiceError && (
              <span className={styles.voiceStatus}>{voiceError}</span>
            )}
            {!voiceLoading && !voiceError && voiceAvailable && (
              <span className={`${styles.voiceStatus} ${styles.voiceStatusOk}`}>Ready</span>
            )}
            {!voiceLoading && !voiceError && !voiceAvailable && (
              <span className={styles.voiceStatus}>No voice data</span>
            )}
          </div>
          <div className={styles.voiceBarRow}>
            <button className={styles.masterMuteBtn} onClick={() => muteTeam('CT')}>Mute CT</button>
            <button className={styles.masterMuteBtn} onClick={() => muteTeam('T')}>Mute T</button>
            <button className={styles.masterMuteBtn} onClick={muteAll}>Mute All</button>
            <button className={styles.masterMuteBtn} onClick={unmuteAll}>Unmute All</button>
          </div>
        </div>
      )}

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
