/**
 * TeamSessionLibrary — list of persisted team sessions; click to load.
 * Supports single delete and bulk delete via checkboxes.
 */

import React, { useEffect, useState } from 'react';
import {
  listTeamSessions,
  deleteTeamSession,
  getTeamSession,
  getMaps,
} from '../../utils/api';
import { useAppStore } from '../../store/demoStore';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import type { TeamSessionListItem } from '../../types';
import teamStyles from './TeamLoader.module.css';
import styles from './TeamSessionLibrary.module.css';

interface Props {
  onLoaded: () => void;
}

const TeamSessionLibrary: React.FC<Props> = ({ onLoaded }) => {
  const [sessions, setSessions] = useState<TeamSessionListItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const setTeamSession  = useAppStore((s) => s.setTeamSession);
  const setActiveDemoId = useAppStore((s) => s.setActiveDemoId);
  const setMaps         = useAppStore((s) => s.setMaps);

  useEffect(() => {
    listTeamSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, []);

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allSelected = sessions.length > 0 && selected.size === sessions.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)));
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} team session(s)? (Demos are kept.)`)) return;
    setDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((id) => deleteTeamSession(id)));
      const removed = selected;
      setSessions((prev) => prev.filter((s) => !removed.has(s.id)));
      setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  };

  const handleLoad = async (id: string) => {
    setBusy(id);
    try {
      const [session, maps] = await Promise.all([
        getTeamSession(id),
        getMaps(),
      ]);
      setMaps(maps);
      setTeamSession(session);
      const firstDemoId = session.demo_ids[0];
      setActiveDemoId(firstDemoId);
      await loadDemoIntoStore(firstDemoId, { maps });
      onLoaded();
    } catch {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this team session? (Demos themselves are kept.)')) return;
    setBusy(id);
    try {
      await deleteTeamSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p className={teamStyles.empty}>Loading sessions…</p>;
  if (sessions.length === 0) {
    return <p className={teamStyles.empty}>No saved team sessions yet.</p>;
  }

  return (
    <div className={styles.root}>
      <div className={styles.bulkBar}>
        <label className={styles.selectAllLabel}>
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          All
        </label>
        {selected.size > 0 && (
          <button
            className={styles.bulkDeleteBtn}
            onClick={handleBulkDelete}
            disabled={deleting}
          >
            {deleting ? '…' : `Delete (${selected.size})`}
          </button>
        )}
      </div>
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`${styles.row} ${selected.has(s.id) ? styles.rowSelected : ''}`}
          onClick={() => handleLoad(s.id)}
          style={{ opacity: busy === s.id ? 0.5 : 1 }}
        >
          <input
            type="checkbox"
            className={styles.rowCheck}
            checked={selected.has(s.id)}
            onChange={() => {}}
            onClick={(e) => toggleSelect(s.id, e)}
          />
          <span className={styles.name}>{s.name}</span>
          <span className={styles.meta}>
            {s.map_name} · {s.demo_count} demos
          </span>
          <button
            className={styles.deleteBtn}
            onClick={(e) => handleDelete(s.id, e)}
            disabled={busy === s.id || deleting}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};

export default TeamSessionLibrary;
