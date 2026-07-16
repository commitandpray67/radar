/**
 * TimelineMarkers — seekable event markers rendered over the playback scrubber.
 *
 * Kills are tinted by the victim's side; every marker has a descriptive tooltip
 * and is a real <button> so it's keyboard-reachable. Single-round mode only.
 */

import React from 'react';
import type { GameEvent } from '../../types';
import styles from './PlaybackControls.module.css';

export interface PositionedEvent extends GameEvent {
  pct: number;
}

interface Props {
  events: PositionedEvent[];
  playersById: Map<number, string>;
  teamByPlayer: Map<number, number>;
  onSeek: (tick: number) => void;
}

function tooltip(ev: PositionedEvent, name: (id: number | null) => string): string {
  switch (ev.event_type) {
    case 'player_death': {
      const w = ev.weapon ? ` (${ev.weapon}${ev.headshot ? ', HS' : ''})` : '';
      return `${name(ev.attacker_id)} ⟶ ${name(ev.victim_id)}${w}`;
    }
    case 'bomb_planted':
      return `Bomb planted${ev.weapon ? ` (${ev.weapon})` : ''}`;
    case 'bomb_defused':
      return 'Bomb defused';
    case 'bomb_exploded':
      return 'Bomb exploded';
    default:
      return ev.event_type.replace(/_/g, ' ');
  }
}

const TimelineMarkers: React.FC<Props> = ({ events, playersById, teamByPlayer, onSeek }) => {
  const name = (id: number | null) => (id != null ? playersById.get(id) ?? '?' : '?');

  return (
    <>
      {events.map((ev) => {
        const markerClass = (styles as Record<string, string>)[`marker_${ev.event_type}`] ?? '';
        // Tint kill markers by the victim's side.
        const victimTeam = ev.event_type === 'player_death' && ev.victim_id != null
          ? teamByPlayer.get(ev.victim_id)
          : undefined;
        const sideClass = victimTeam === 3 ? styles.markerCT
          : victimTeam === 2 ? styles.markerT : '';
        return (
          <button
            key={ev.id ?? `${ev.tick}:${ev.event_type}:${ev.victim_id}`}
            type="button"
            className={`${styles.eventMarker} ${markerClass} ${sideClass}`}
            style={{ left: `${ev.pct}%` }}
            onClick={() => onSeek(ev.tick)}
            title={tooltip(ev, name)}
            aria-label={tooltip(ev, name)}
          />
        );
      })}
    </>
  );
};

export default TimelineMarkers;
