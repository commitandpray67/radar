/**
 * WeaponPicker — multi-select of weapons for the highlight search.
 *
 * Collapsed it shows the current selection ("Any weapon" when empty); expanded
 * it lists every weapon grouped by class as toggle chips.
 */

import React, { useState } from 'react';
import { HIGHLIGHT_WEAPON_GROUPS, weaponsText } from '../../utils/highlights';
import styles from './Highlights.module.css';

interface Props {
  selected: string[];
  onChange: (tokens: string[]) => void;
}

const WeaponPicker: React.FC<Props> = ({ selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const chosen = new Set(selected);

  const toggle = (token: string) => {
    const next = new Set(chosen);
    if (next.has(token)) next.delete(token); else next.add(token);
    // Keep the picker's display order rather than click order.
    onChange(HIGHLIGHT_WEAPON_GROUPS
      .flatMap((g) => g.weapons.map(([t]) => t))
      .filter((t) => next.has(t)));
  };

  const summary = selected.length ? weaponsText(selected) : 'Any weapon';

  return (
    <div className={styles.weaponPicker}>
      <button
        type="button"
        className={styles.weaponToggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={summary}
      >
        <span className={styles.weaponSummary}>{summary}</span>
        <span>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className={styles.weaponPanel}>
          <div className={styles.weaponPanelHead}>
            <span className={styles.fieldHint}>
              Tick one or more. None ticked = any weapon.
            </span>
            {selected.length > 0 && (
              <button type="button" className={styles.linkBtn} onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
          {HIGHLIGHT_WEAPON_GROUPS.map((g) => (
            <div key={g.group} className={styles.weaponGroup}>
              <span className={styles.weaponGroupName}>{g.group}</span>
              <div className={styles.weaponChips}>
                {g.weapons.map(([token, label]) => (
                  <button
                    key={token}
                    type="button"
                    className={`${styles.weaponChip} ${chosen.has(token) ? styles.chipActive : ''}`}
                    onClick={() => toggle(token)}
                    aria-pressed={chosen.has(token)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default WeaponPicker;
