/**
 * PlayerInfoPanel — live per-player HP, armor, and weapon state.
 *
 * State is reconstructed at each tick by replaying player_state_events
 * in order up to currentTick:
 *   spawn  → hp=100, armor=0
 *   hurt   → hp=event.hp, armor=event.armor
 *   equip  → weapon=event.weapon
 *
 * Only events from the active round are considered.
 */

import React, { useMemo } from 'react';
import { useAppStore } from '../../store/demoStore';
import styles from './PlayerInfoPanel.module.css';

// Strip "weapon_" prefix from weapon name for display
function formatWeapon(raw: string | null | undefined): string {
  if (!raw) return '—';
  return raw.replace(/^weapon_/, '').replace(/_/g, ' ');
}

interface PlayerState {
  hp: number;
  armor: number;
  weapon: string;
}

const PlayerInfoPanel: React.FC = () => {
  const players           = useAppStore((s) => s.players);
  const activeRound       = useAppStore((s) => s.activeRound);
  const currentTick       = useAppStore((s) => s.currentTick);
  const playerStateEvents = useAppStore((s) => s.playerStateEvents);
  const events            = useAppStore((s) => s.events);

  // Build current state per player by replaying events up to currentTick
  const playerStates = useMemo<Map<number, PlayerState>>(() => {
    const state = new Map<number, PlayerState>();
    if (activeRound === null) return state;

    // Initialise all players to round-start defaults
    for (const p of players) {
      state.set(p.player_id, { hp: 100, armor: 0, weapon: '' });
    }

    // Replay state events in tick order up to currentTick
    for (const ev of playerStateEvents) {
      if (ev.round_number !== activeRound) continue;
      if (ev.tick > currentTick) continue;
      const cur = state.get(ev.player_id) ?? { hp: 100, armor: 0, weapon: '' };
      if (ev.event_type === 'spawn') {
        state.set(ev.player_id, { hp: 100, armor: 0, weapon: cur.weapon });
      } else if (ev.event_type === 'hurt') {
        state.set(ev.player_id, {
          hp:     ev.hp    ?? cur.hp,
          armor:  ev.armor ?? cur.armor,
          weapon: cur.weapon,
        });
      } else if (ev.event_type === 'equip') {
        state.set(ev.player_id, { ...cur, weapon: ev.weapon ?? cur.weapon });
      }
    }

    return state;
  }, [players, activeRound, currentTick, playerStateEvents]);

  // Check deaths from events
  const deadSet = useMemo<Set<number>>(() => {
    const s = new Set<number>();
    if (activeRound === null) return s;
    for (const ev of events) {
      if (ev.round_number !== activeRound) continue;
      if (ev.event_type !== 'player_death') continue;
      if (ev.tick > currentTick) continue;
      if (ev.victim_id) s.add(ev.victim_id);
    }
    return s;
  }, [events, activeRound, currentTick]);

  if (!players.length) {
    return <div className={styles.empty}>—</div>;
  }

  // Split into CT and T based on position data team_num (or initial_team as fallback)
  const ctPlayers = players.filter((p) => p.initial_team === 'CT');
  const tPlayers  = players.filter((p) => p.initial_team !== 'CT');

  const renderPlayer = (p: typeof players[0], idx: number) => {
    const st     = playerStates.get(p.player_id) ?? { hp: 100, armor: 0, weapon: '' };
    const isAlive = !deadSet.has(p.player_id);
    const hp     = isAlive ? st.hp : 0;
    const hpPct  = Math.max(0, Math.min(100, hp));
    const hpColor = hpPct > 60 ? '#3a8a3a' : hpPct > 25 ? '#a08020' : '#8a2020';
    const isCT   = p.initial_team === 'CT';

    return (
      <div
        key={p.player_id}
        className={`${styles.playerRow} ${!isAlive ? styles.dead : ''}`}
      >
        <span className={`${styles.playerNum} ${isCT ? styles.numCT : styles.numT}`}>
          {idx + 1}
        </span>
        <span className={styles.playerName} title={p.name}>{p.name}</span>

        {/* HP bar */}
        <div className={styles.hpBarWrap}>
          <div
            className={styles.hpBarFill}
            style={{ width: `${hpPct}%`, background: hpColor }}
          />
          <span className={styles.hpLabel}>{isAlive ? hp : '✕'}</span>
        </div>

        {/* Armor */}
        <span
          className={styles.armor}
          title={`Armor: ${st.armor}`}
          style={{ opacity: st.armor > 0 ? 1 : 0.25 }}
        >
          🛡
        </span>

        {/* Weapon */}
        <span className={styles.weapon}>{isAlive ? formatWeapon(st.weapon) : '—'}</span>
      </div>
    );
  };

  return (
    <div className={styles.root}>
      {ctPlayers.length > 0 && (
        <div className={styles.teamSection}>
          <div className={styles.teamLabel} style={{ color: '#5b9bd5' }}>CT</div>
          {ctPlayers.map((p, idx) => renderPlayer(p, idx))}
        </div>
      )}
      {tPlayers.length > 0 && (
        <div className={styles.teamSection}>
          <div className={styles.teamLabel} style={{ color: '#e07b39' }}>T</div>
          {tPlayers.map((p, idx) => renderPlayer(p, ctPlayers.length + idx))}
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
