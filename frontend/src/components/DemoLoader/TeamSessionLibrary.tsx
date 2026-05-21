/**
 * TeamSessionLibrary — list of persisted team sessions; click to load.
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

interface Props {
  onLoaded: () => void;
}

const TeamSessionLibrary: React.FC<Props> = ({ onLoaded }) => {
  const [sessions, setSessions] = useState<TeamSessionListItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState<string | null>(null);

  const setTeamSession  = useAppStore((s) => s.setTeamSession);
  const setActiveDemoId = useAppStore((s) => s.setActiveDemoId);
  const setMaps         = useAppStore((s) => s.setMaps);

  useEffect(() => {
    listTeamSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, []);

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
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p className={teamStyles.empty}>Loading sessions…</p>;
  if (sessions.length === 0) {
    return <p className={teamStyles.empty}>No saved team sessions yet.</p>;
  }

  return (
    <div className={teamStyles.libraryList}>
      {sessions.map((s) => (
        <div
          key={s.id}
          className={teamStyles.libRow}
          onClick={() => handleLoad(s.id)}
          style={{ cursor: 'pointer', opacity: busy === s.id ? 0.5 : 1 }}
        >
          <span className={teamStyles.libName}>{s.name}</span>
          <span className={teamStyles.libMeta}>
            {s.map_name} · {s.demo_count} demos
          </span>
          <button
            className={teamStyles.removeBtn}
            onClick={(e) => handleDelete(s.id, e)}
            disabled={busy === s.id}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};

export default TeamSessionLibrary;
