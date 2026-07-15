/**
 * TeamLoader — multi-demo upload for team analysis, across any mix of maps.
 *
 * Workflow:
 *   1. User uploads several .dem files (or picks them from the library) — the
 *      maps can differ.
 *   2. Each demo is uploaded/parsed (or loaded from cache).
 *   3. The demos are auto-sorted by map. The user names the team; we create a
 *      team container and add every parsed demo to it.
 *   4. The team's maps are listed; clicking a map opens that map's analysis
 *      (a multi-demo team session, or a single demo when only one exists).
 *
 * Reuses the single-demo upload/parse machinery and the team-organizer model
 * (teams group demos by map; each map opens its own session).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadDemo,
  watchParseStatus,
  listDemos,
  getDemo,
  getMaps,
  createTeam,
  getTeam,
  addDemosToTeam,
  validateTeamSession,
  createTeamSession,
  getTeamSession,
} from '../../utils/api';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import { useAppStore } from '../../store/demoStore';
import type {
  DemoMeta,
  ParseJobStatus,
  TeamDetail,
} from '../../types';
import styles from './DemoLoader.module.css';
import teamStyles from './TeamLoader.module.css';

interface UploadedDemo {
  demo_id: string;
  filename: string;
  map_name?: string;
  status: 'pending' | 'uploading' | 'parsing' | 'ready' | 'error';
  progress?: number;     // 0..1
  message?: string;
  error?: string;
}

interface Props {
  onComplete: () => void;       // called after a map's session is loaded
}

const TeamLoader: React.FC<Props> = ({ onComplete }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [demos, setDemos] = useState<UploadedDemo[]>([]);
  const [libraryDemos, setLibraryDemos] = useState<DemoMeta[]>([]);
  const [pickedFromLibrary, setPickedFromLibrary] = useState<Set<string>>(new Set());
  const [showLibrary, setShowLibrary] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [creating, setCreating] = useState(false);
  const [teamDetail, setTeamDetail] = useState<TeamDetail | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const setMaps = useAppStore((s) => s.setMaps);
  const setTeamSession = useAppStore((s) => s.setTeamSession);
  const setActiveDemoId = useAppStore((s) => s.setActiveDemoId);

  useEffect(() => {
    getMaps().then(setMaps).catch(() => {});
    listDemos().then((d) =>
      setLibraryDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at))),
    ).catch(() => setLibraryDemos([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadOne = useCallback(async (file: File): Promise<void> => {
    if (!file.name.toLowerCase().endsWith('.dem')) {
      setErrorMsg(`'${file.name}' is not a .dem file`);
      return;
    }
    const tempEntry: UploadedDemo = {
      demo_id: '',
      filename: file.name,
      status: 'uploading',
      progress: 0,
    };
    setDemos((prev) => [...prev, tempEntry]);

    try {
      const { job_id, demo_id, cached } = await uploadDemo(file, (pct) => {
        setDemos((prev) => prev.map((d) =>
          d.filename === file.name && d.status === 'uploading'
            ? { ...d, progress: pct * 0.15 }
            : d,
        ));
      });

      setDemos((prev) => prev.map((d) =>
        d.filename === file.name
          ? { ...d, demo_id, status: cached ? 'ready' : 'parsing', progress: 0.15 }
          : d,
      ));

      if (!cached) {
        await watchParseStatus(job_id, (status: ParseJobStatus) => {
          setDemos((prev) => prev.map((d) =>
            d.demo_id === demo_id
              ? { ...d, progress: status.progress, message: status.message }
              : d,
          ));
        });
      }

      // Fetch the resolved map name so we can group by map.
      let mapName = '';
      try {
        mapName = (await getDemo(demo_id)).map_name;
      } catch { /* leave blank; grouped under "unknown" */ }

      setDemos((prev) => prev.map((d) =>
        d.demo_id === demo_id
          ? { ...d, status: 'ready', progress: 1, map_name: mapName }
          : d,
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDemos((prev) => prev.map((d) =>
        d.filename === file.name ? { ...d, status: 'error', error: msg } : d,
      ));
    }
  }, []);

  const onFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErrorMsg('');
    setTeamDetail(null);   // new uploads invalidate a previously-created team view
    for (const f of Array.from(files)) {
      await uploadOne(f);
    }
  };

  const removeUploadedDemo = (demoId: string) => {
    setDemos((prev) => prev.filter((d) => d.demo_id !== demoId));
    setTeamDetail(null);
  };

  const toggleLibraryDemo = (demoId: string) => {
    setTeamDetail(null);
    setPickedFromLibrary((prev) => {
      const next = new Set(prev);
      if (next.has(demoId)) next.delete(demoId); else next.add(demoId);
      return next;
    });
  };

  // All demos that will go into the team: parsed uploads + library picks.
  const libById = new Map(libraryDemos.map((d) => [d.id, d]));
  const combined = [
    ...demos
      .filter((d) => d.status === 'ready' && d.demo_id)
      .map((d) => ({ id: d.demo_id, filename: d.filename, map: d.map_name || 'unknown' })),
    ...Array.from(pickedFromLibrary).map((id) => {
      const d = libById.get(id);
      return { id, filename: d?.filename ?? id, map: d?.map_name ?? 'unknown' };
    }),
  ];
  // Dedupe by demo id (a library pick could duplicate an upload).
  const seenIds = new Set<string>();
  const uniqueCombined = combined.filter((c) => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  });

  // Group by map for the auto-sort preview.
  const groups = new Map<string, { id: string; filename: string }[]>();
  for (const c of uniqueCombined) {
    if (!groups.has(c.map)) groups.set(c.map, []);
    groups.get(c.map)!.push({ id: c.id, filename: c.filename });
  }
  const mapGroups = Array.from(groups.entries())
    .map(([map_name, ds]) => ({ map_name, demos: ds }))
    .sort((a, b) => a.map_name.localeCompare(b.map_name));

  const allReady = demos.every((d) => d.status === 'ready' || d.status === 'error');
  const canCreate = uniqueCombined.length >= 2 && allReady;

  const handleCreateTeam = async () => {
    if (!teamName.trim()) {
      setErrorMsg('Please enter a team name');
      return;
    }
    if (uniqueCombined.length < 2) {
      setErrorMsg('Add at least 2 demos');
      return;
    }
    setCreating(true);
    setErrorMsg('');
    try {
      const team = await createTeam(teamName.trim());
      await addDemosToTeam(team.id, uniqueCombined.map((c) => c.id));
      const detail = await getTeam(team.id);
      setTeamDetail(detail);
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail ?? (err as Error)?.message ?? 'Failed to create team';
      setErrorMsg(String(msg));
    } finally {
      setCreating(false);
    }
  };

  // Open one map group: single demo loads directly, multiple form a session.
  const handleOpenMap = useCallback(async (
    mapName: string,
    demoIds: string[],
  ) => {
    setOpeningKey(mapName);
    setErrorMsg('');
    try {
      const freshMaps = await getMaps();
      setMaps(freshMaps);

      if (demoIds.length === 1) {
        await loadDemoIntoStore(demoIds[0], { maps: freshMaps });
        onComplete();
        return;
      }

      const validation = await validateTeamSession(demoIds);
      if (!validation.ok) {
        setErrorMsg(`${mapName}: ${validation.error ?? 'team validation failed'}`);
        return;
      }

      const label = teamName.trim() || teamDetail?.name || 'Team';
      const { id: sessionId } = await createTeamSession(`${label} · ${mapName}`, demoIds);
      const session = await getTeamSession(sessionId);
      setTeamSession(session);
      const firstDemoId = session.demo_ids[0];
      setActiveDemoId(firstDemoId);
      await loadDemoIntoStore(firstDemoId, { maps: freshMaps });
      onComplete();
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail ?? (err as Error)?.message ?? 'Failed to open map';
      setErrorMsg(String(msg));
    } finally {
      setOpeningKey(null);
    }
  }, [teamName, teamDetail, setMaps, setTeamSession, setActiveDemoId, onComplete]);

  // Prefer the freshly-created team detail (map groups from the DB) if present.
  const displayGroups = teamDetail
    ? teamDetail.maps.map((m) => ({
        map_name: m.map_name,
        demos: m.demos.map((d) => ({ id: d.id, filename: d.filename })),
      }))
    : mapGroups;

  return (
    <div className={teamStyles.root}>
      <p className={teamStyles.intro}>
        Upload any number of demos — <strong>maps can differ</strong>. They're
        sorted by map into a team; click a map to analyse that team's matches.
      </p>

      <button
        className={styles.libraryToggle}
        onClick={() => inputRef.current?.click()}
      >
        + Add demos
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".dem"
        multiple
        className={styles.hiddenInput}
        onChange={(e) => onFilesPicked(e.target.files)}
      />

      {demos.length > 0 && (
        <div className={teamStyles.demoList}>
          {demos.map((d) => (
            <div key={d.filename + d.demo_id} className={teamStyles.demoRow}>
              <span className={teamStyles.demoName}>{d.filename}</span>
              <span className={teamStyles.demoStatus}>
                {d.status === 'uploading' && `Uploading ${Math.round((d.progress ?? 0) * 100)}%`}
                {d.status === 'parsing'   && `Parsing ${Math.round((d.progress ?? 0) * 100)}%`}
                {d.status === 'ready'     && (d.map_name ? d.map_name : '✓')}
                {d.status === 'error'     && `Error: ${d.error}`}
              </span>
              {(d.status === 'ready' || d.status === 'error') && (
                <button
                  className={teamStyles.removeBtn}
                  onClick={() => removeUploadedDemo(d.demo_id)}
                  title="Remove"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        className={styles.libraryToggle}
        onClick={() => setShowLibrary((s) => !s)}
      >
        {showLibrary ? 'Hide library' : `Pick from library (${libraryDemos.length})`}
      </button>

      {showLibrary && (
        <div className={teamStyles.libraryList}>
          {libraryDemos.length === 0 && (
            <p className={teamStyles.empty}>No cached demos yet.</p>
          )}
          {libraryDemos.map((d) => (
            <label key={d.id} className={teamStyles.libRow}>
              <input
                type="checkbox"
                checked={pickedFromLibrary.has(d.id)}
                onChange={() => toggleLibraryDemo(d.id)}
              />
              <span className={teamStyles.libName}>{d.filename}</span>
              <span className={teamStyles.libMeta}>{d.map_name}</span>
            </label>
          ))}
        </div>
      )}

      {/* Auto-sorted preview + team creation (before the team is created) */}
      {!teamDetail && uniqueCombined.length > 0 && (
        <div className={teamStyles.validationBox}>
          <p className={teamStyles.validOk}>
            {uniqueCombined.length} demo{uniqueCombined.length !== 1 ? 's' : ''} across{' '}
            {mapGroups.length} map{mapGroups.length !== 1 ? 's' : ''}
          </p>
          {mapGroups.map((g) => (
            <p key={g.map_name} className={teamStyles.sideRow}>
              <span className={teamStyles.sideFilename}>{g.map_name}</span>
              <span className={teamStyles.demoStatus}>
                {g.demos.length} match{g.demos.length !== 1 ? 'es' : ''}
              </span>
            </p>
          ))}
        </div>
      )}

      {!teamDetail && (
        <>
          <input
            type="text"
            placeholder="Team name (e.g. 'NaVi')"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            className={teamStyles.nameInput}
            maxLength={60}
          />
          <button
            className={teamStyles.createBtn}
            onClick={handleCreateTeam}
            disabled={creating || !teamName.trim() || !canCreate}
          >
            {creating
              ? 'Creating…'
              : `Create team (${uniqueCombined.length} demo${uniqueCombined.length !== 1 ? 's' : ''})`}
          </button>
        </>
      )}

      {/* After the team is created: pick a map to open */}
      {teamDetail && (
        <div className={teamStyles.validationBox}>
          <p className={teamStyles.validOk}>
            ✓ {teamDetail.name} — choose a map to analyse
          </p>
          {displayGroups.map((g) => (
            <div key={g.map_name} className={teamStyles.mapOpenRow}>
              <span className={teamStyles.mapOpenName}>{g.map_name}</span>
              <span className={teamStyles.demoStatus}>
                {g.demos.length} match{g.demos.length !== 1 ? 'es' : ''}
              </span>
              <button
                className={teamStyles.openBtn}
                onClick={() => handleOpenMap(g.map_name, g.demos.map((d) => d.id))}
                disabled={openingKey !== null}
              >
                {openingKey === g.map_name ? 'Opening…' : 'Open'}
              </button>
            </div>
          ))}
        </div>
      )}

      {errorMsg && <p className={teamStyles.validErr}>{errorMsg}</p>}
    </div>
  );
};

export default TeamLoader;
