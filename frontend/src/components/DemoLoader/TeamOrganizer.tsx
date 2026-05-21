/**
 * TeamOrganizer — create named teams, add demos from any map, and open
 * per-map team analysis sessions.
 *
 * Teams are just organizational containers: you give a team a name (e.g.
 * "NaVi"), add demos from the library, and the system groups them by map.
 * Clicking "Open" on a map group creates or loads a team analysis session.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  createTeam, listTeams, getTeam, deleteTeam,
  addDemosToTeam, removeDemoFromTeam,
  listDemos,
  validateTeamSession, createTeamSession, getTeamSession, getMaps,
} from '../../utils/api';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import { useAppStore } from '../../store/demoStore';
import type { TeamInfo, TeamDetail, DemoMeta } from '../../types';
import styles from './TeamOrganizer.module.css';

interface Props {
  onSessionLoaded: () => void;
}

const TeamOrganizer: React.FC<Props> = ({ onSessionLoaded }) => {
  const [teams, setTeams]           = useState<TeamInfo[]>([]);
  const [loading, setLoading]       = useState(true);
  const [details, setDetails]       = useState<Record<string, TeamDetail>>({});
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());
  const [newName, setNewName]       = useState('');
  const [creating, setCreating]     = useState(false);
  const [busyTeam, setBusyTeam]     = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null); // `${teamId}:${mapName}`
  const [openError, setOpenError]   = useState('');
  const [showAddTo, setShowAddTo]   = useState<string | null>(null); // team ID
  const [libDemos, setLibDemos]     = useState<DemoMeta[]>([]);
  const [toAdd, setToAdd]           = useState<Set<string>>(new Set());
  const [adding, setAdding]         = useState(false);

  const setTeamSession  = useAppStore((s) => s.setTeamSession);
  const setActiveDemoId = useAppStore((s) => s.setActiveDemoId);
  const setMaps         = useAppStore((s) => s.setMaps);

  useEffect(() => {
    listTeams()
      .then(setTeams)
      .catch(() => setTeams([]))
      .finally(() => setLoading(false));
  }, []);

  // When add-demos panel opens, load both the library and the team detail
  useEffect(() => {
    if (showAddTo === null) return;
    listDemos()
      .then((d) => setLibDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at))))
      .catch(() => setLibDemos([]));
    if (!details[showAddTo]) {
      getTeam(showAddTo)
        .then((d) => setDetails((prev) => ({ ...prev, [showAddTo]: d })))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAddTo]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const team = await createTeam(newName.trim());
      setTeams((prev) => [team, ...prev]);
      setNewName('');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (teamId: string) => {
    if (!window.confirm('Delete this team? (Demos are kept in the library.)')) return;
    setBusyTeam(teamId);
    try {
      await deleteTeam(teamId);
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      setExpanded((prev) => { const n = new Set(prev); n.delete(teamId); return n; });
      setDetails((prev) => { const n = { ...prev }; delete n[teamId]; return n; });
      if (showAddTo === teamId) setShowAddTo(null);
    } finally {
      setBusyTeam(null);
    }
  };

  const toggleExpand = async (teamId: string) => {
    if (expanded.has(teamId)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(teamId); return n; });
      return;
    }
    if (!details[teamId]) {
      setBusyTeam(teamId);
      try {
        const detail = await getTeam(teamId);
        setDetails((prev) => ({ ...prev, [teamId]: detail }));
      } finally {
        setBusyTeam(null);
      }
    }
    setExpanded((prev) => new Set([...prev, teamId]));
  };

  const handleRemoveDemo = async (teamId: string, demoId: string) => {
    setBusyTeam(teamId);
    try {
      await removeDemoFromTeam(teamId, demoId);
      const detail = await getTeam(teamId);
      const newCount = detail.maps.reduce((s, m) => s + m.demos.length, 0);
      setDetails((prev) => ({ ...prev, [teamId]: detail }));
      setTeams((prev) => prev.map((t) =>
        t.id === teamId ? { ...t, demo_count: newCount } : t
      ));
    } finally {
      setBusyTeam(null);
    }
  };

  const handleAddDemos = async (teamId: string) => {
    if (toAdd.size === 0) return;
    setAdding(true);
    try {
      await addDemosToTeam(teamId, Array.from(toAdd));
      const detail = await getTeam(teamId);
      const newCount = detail.maps.reduce((s, m) => s + m.demos.length, 0);
      setDetails((prev) => ({ ...prev, [teamId]: detail }));
      setTeams((prev) => prev.map((t) =>
        t.id === teamId ? { ...t, demo_count: newCount } : t
      ));
      setToAdd(new Set());
      setShowAddTo(null);
      // Expand to show the newly added demos
      setExpanded((prev) => new Set([...prev, teamId]));
    } finally {
      setAdding(false);
    }
  };

  const handleOpenMap = useCallback(async (
    teamId: string,
    mapName: string,
    demoIds: string[],
  ) => {
    const key = `${teamId}:${mapName}`;
    setOpeningKey(key);
    setOpenError('');
    try {
      const freshMaps = await getMaps();
      setMaps(freshMaps);

      if (demoIds.length === 1) {
        await loadDemoIntoStore(demoIds[0], { maps: freshMaps });
        onSessionLoaded();
        return;
      }

      const validation = await validateTeamSession(demoIds);
      if (!validation.ok) {
        setOpenError(validation.error ?? 'Team validation failed');
        return;
      }

      const teamName = details[teamId]?.name ?? 'Team';
      const { id: sessionId } = await createTeamSession(
        `${teamName} · ${mapName}`,
        demoIds,
      );
      const session = await getTeamSession(sessionId);
      setTeamSession(session);
      const firstDemoId = session.demo_ids[0];
      setActiveDemoId(firstDemoId);
      await loadDemoIntoStore(firstDemoId, { maps: freshMaps });
      onSessionLoaded();
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail ?? (err as Error)?.message ?? 'Failed to open';
      setOpenError(String(msg));
    } finally {
      setOpeningKey(null);
    }
  }, [details, setMaps, setTeamSession, setActiveDemoId, onSessionLoaded]);

  if (loading) return <p className={styles.empty}>Loading teams…</p>;

  return (
    <div className={styles.root}>
      {/* Create team */}
      <div className={styles.createForm}>
        <input
          type="text"
          className={styles.nameInput}
          placeholder="Team name (e.g. NaVi)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          maxLength={60}
        />
        <button
          className={styles.createBtn}
          onClick={handleCreate}
          disabled={creating || !newName.trim()}
        >
          {creating ? '…' : 'Create'}
        </button>
      </div>

      {openError && (
        <p className={styles.error} onClick={() => setOpenError('')}>{openError}</p>
      )}

      {teams.length === 0 && !loading && (
        <p className={styles.empty}>No teams yet. Create one above.</p>
      )}

      <div className={styles.teamList}>
        {teams.map((team) => {
          const isExpanded = expanded.has(team.id);
          const isBusy = busyTeam === team.id;
          const detail = details[team.id];

          // Compute which demos are already in this team (for the add panel)
          const alreadyInSet = new Set(
            detail?.maps.flatMap((m) => m.demos.map((d) => d.id)) ?? []
          );

          return (
            <div key={team.id} className={styles.teamCard}>
              <div className={styles.teamHeader}>
                <button
                  className={styles.expandBtn}
                  onClick={() => toggleExpand(team.id)}
                  disabled={isBusy}
                  title={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? '▾' : '▸'}
                </button>
                <span className={styles.teamName}>{team.name}</span>
                <span className={styles.teamCount}>{team.demo_count} demo{team.demo_count !== 1 ? 's' : ''}</span>
                <button
                  className={styles.addBtn}
                  onClick={() => {
                    setShowAddTo(showAddTo === team.id ? null : team.id);
                    setToAdd(new Set());
                  }}
                  title="Add demos to team"
                  disabled={isBusy}
                >
                  +
                </button>
                <button
                  className={styles.deleteTeamBtn}
                  onClick={() => handleDelete(team.id)}
                  disabled={isBusy}
                  title="Delete team"
                >
                  ✕
                </button>
              </div>

              {/* Add demos panel */}
              {showAddTo === team.id && (
                <div className={styles.addPanel}>
                  <p className={styles.addHint}>Select demos to add:</p>
                  <div className={styles.libList}>
                    {libDemos.filter((d) => !alreadyInSet.has(d.id)).length === 0 && (
                      <p className={styles.empty}>All library demos already in team.</p>
                    )}
                    {libDemos
                      .filter((d) => !alreadyInSet.has(d.id))
                      .map((d) => (
                        <label key={d.id} className={styles.libRow}>
                          <input
                            type="checkbox"
                            checked={toAdd.has(d.id)}
                            onChange={() => setToAdd((prev) => {
                              const n = new Set(prev);
                              n.has(d.id) ? n.delete(d.id) : n.add(d.id);
                              return n;
                            })}
                          />
                          <span className={styles.libName} title={d.filename}>{d.filename}</span>
                          <span className={styles.libMeta}>{d.map_name}</span>
                        </label>
                      ))}
                  </div>
                  <button
                    className={styles.addConfirmBtn}
                    onClick={() => handleAddDemos(team.id)}
                    disabled={adding || toAdd.size === 0}
                  >
                    {adding ? 'Adding…' : `Add ${toAdd.size > 0 ? toAdd.size : ''} demo${toAdd.size !== 1 ? 's' : ''}`}
                  </button>
                </div>
              )}

              {/* Expanded map groups */}
              {isExpanded && detail && (
                <div className={styles.teamDetail}>
                  {detail.maps.length === 0 ? (
                    <p className={styles.empty}>No demos yet — use + to add some.</p>
                  ) : (
                    detail.maps.map((mapGroup) => {
                      const key = `${team.id}:${mapGroup.map_name}`;
                      const isOpening = openingKey === key;
                      return (
                        <div key={mapGroup.map_name} className={styles.mapGroup}>
                          <div className={styles.mapHeader}>
                            <span className={styles.mapName}>{mapGroup.map_name}</span>
                            <span className={styles.mapCount}>
                              {mapGroup.demos.length} match{mapGroup.demos.length !== 1 ? 'es' : ''}
                            </span>
                            <button
                              className={styles.openBtn}
                              onClick={() => handleOpenMap(
                                team.id, mapGroup.map_name,
                                mapGroup.demos.map((d) => d.id),
                              )}
                              disabled={openingKey !== null || isBusy}
                            >
                              {isOpening ? 'Opening…' : 'Open'}
                            </button>
                          </div>
                          {mapGroup.demos.map((d, idx) => (
                            <div key={d.id} className={styles.demoRow}>
                              <span className={styles.matchNum}>M{idx + 1}</span>
                              <span className={styles.demoName} title={d.filename}>
                                {d.filename}
                              </span>
                              <button
                                className={styles.removeDemoBtn}
                                onClick={() => handleRemoveDemo(team.id, d.id)}
                                disabled={isBusy}
                                title="Remove from team"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TeamOrganizer;
