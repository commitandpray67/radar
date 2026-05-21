/**
 * TeamLoader — multi-demo upload + validation flow for team-analysis sessions.
 *
 * Workflow:
 *   1. User uploads multiple .dem files OR picks them from the library
 *   2. Each demo is uploaded/parsed (or loaded from cache) sequentially
 *   3. Once all demos are in the DB, hit /team-sessions/validate
 *   4. Show roster preview + per-demo team side; ask for a name; create session
 *
 * Reuses existing single-demo upload/parse machinery.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  uploadDemo,
  watchParseStatus,
  listDemos,
  validateTeamSession,
  createTeamSession,
  getTeamSession,
} from '../../utils/api';
import { loadDemoIntoStore } from '../../utils/demoLoading';
import { useAppStore } from '../../store/demoStore';
import { getMaps } from '../../utils/api';
import type {
  DemoMeta,
  ParseJobStatus,
  TeamSessionValidation,
} from '../../types';
import styles from './DemoLoader.module.css';
import teamStyles from './TeamLoader.module.css';

interface UploadedDemo {
  demo_id: string;
  filename: string;
  status: 'pending' | 'uploading' | 'parsing' | 'ready' | 'error';
  progress?: number;     // 0..1
  message?: string;
  error?: string;
}

interface Props {
  onComplete: () => void;       // called after session is created and loaded
}

const TeamLoader: React.FC<Props> = ({ onComplete }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [demos, setDemos] = useState<UploadedDemo[]>([]);
  const [libraryDemos, setLibraryDemos] = useState<DemoMeta[]>([]);
  const [pickedFromLibrary, setPickedFromLibrary] = useState<Set<string>>(new Set());
  const [showLibrary, setShowLibrary] = useState(false);
  const [validation, setValidation] = useState<TeamSessionValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const setMaps = useAppStore((s) => s.setMaps);
  const setTeamSession = useAppStore((s) => s.setTeamSession);
  const setActiveDemoId = useAppStore((s) => s.setActiveDemoId);
  const maps = useAppStore((s) => s.maps);

  useEffect(() => {
    getMaps().then(setMaps).catch(() => {});
    listDemos().then((d) =>
      setLibraryDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at))),
    ).catch(() => setLibraryDemos([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aggregate list of demo_ids that should be validated
  const allDemoIds = [
    ...demos.filter((d) => d.status === 'ready').map((d) => d.demo_id),
    ...Array.from(pickedFromLibrary),
  ];

  // Re-validate whenever the demo set changes
  useEffect(() => {
    setValidation(null);
    setErrorMsg('');
    if (allDemoIds.length < 2) return;

    setValidating(true);
    validateTeamSession(allDemoIds)
      .then(setValidation)
      .catch((err) => {
        const msg = err?.response?.data?.detail ?? err?.message ?? 'Validation failed';
        setErrorMsg(String(msg));
      })
      .finally(() => setValidating(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDemoIds.join(',')]);

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

      // Update with real demo_id
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

      setDemos((prev) => prev.map((d) =>
        d.demo_id === demo_id ? { ...d, status: 'ready', progress: 1 } : d,
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDemos((prev) => prev.map((d) =>
        d.filename === file.name ? { ...d, status: 'error', error: msg } : d,
      ));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Upload sequentially so the UI shows progress per file
    for (const f of Array.from(files)) {
      await uploadOne(f);
    }
  };

  const removeUploadedDemo = (demoId: string) => {
    setDemos((prev) => prev.filter((d) => d.demo_id !== demoId));
  };

  const toggleLibraryDemo = (demoId: string) => {
    setPickedFromLibrary((prev) => {
      const next = new Set(prev);
      if (next.has(demoId)) next.delete(demoId); else next.add(demoId);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!validation?.ok) return;
    if (!sessionName.trim()) {
      setErrorMsg('Please enter a name for the session');
      return;
    }
    setCreating(true);
    setErrorMsg('');
    try {
      const { id } = await createTeamSession(sessionName.trim(), allDemoIds);
      const session = await getTeamSession(id);

      // Load first demo into the standard store slots so radar/playback work
      setTeamSession(session);
      const firstDemoId = session.demo_ids[0];
      setActiveDemoId(firstDemoId);
      await loadDemoIntoStore(firstDemoId, { maps });

      onComplete();
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail ?? (err as Error)?.message ?? 'Failed to create session';
      setErrorMsg(String(msg));
      setCreating(false);
    }
  };

  const allReady = demos.every((d) => d.status === 'ready' || d.status === 'error');
  const readyCount = demos.filter((d) => d.status === 'ready').length;

  return (
    <div className={teamStyles.root}>
      <p className={teamStyles.intro}>
        Upload multiple demos of the same team on the same map for a bigger
        sample. Need ≥2 demos with ≥4 shared players on the same side.
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
                {d.status === 'ready'     && '✓'}
                {d.status === 'error'     && `Error: ${d.error}`}
              </span>
              {d.status === 'ready' && (
                <button
                  className={teamStyles.removeBtn}
                  onClick={() => removeUploadedDemo(d.demo_id)}
                  title="Remove from session"
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

      {allDemoIds.length >= 2 && (
        <div className={teamStyles.validationBox}>
          {validating && <p className={teamStyles.empty}>Validating…</p>}
          {!validating && validation && validation.ok && (
            <>
              <p className={teamStyles.validOk}>
                ✓ Detected team on <strong>{validation.map_name}</strong>
              </p>
              <p className={teamStyles.rosterLabel}>
                Roster ({validation.core_roster.length} core
                {validation.extended_roster.length > validation.core_roster.length
                  ? `, +${validation.extended_roster.length - validation.core_roster.length} sub${
                      validation.extended_roster.length - validation.core_roster.length > 1 ? 's' : ''
                    }`
                  : ''}):
              </p>
              <p className={teamStyles.rosterNames}>
                {validation.extended_roster.map((sid) => {
                  const name = validation.roster_names[sid] ?? sid;
                  const isSub = !validation.core_roster.includes(sid);
                  return (
                    <span
                      key={sid}
                      className={isSub ? teamStyles.subPlayer : teamStyles.corePlayer}
                      title={isSub ? 'Substitute (not in all demos)' : 'Core player'}
                    >
                      {name}
                    </span>
                  );
                }).reduce<React.ReactNode[]>(
                  (acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]), [],
                )}
              </p>
              <p className={teamStyles.sidesLabel}>Per-demo side:</p>
              {validation.demos.map((d) => (
                <p key={d.demo_id} className={teamStyles.sideRow}>
                  <span className={teamStyles.sideFilename}>{d.filename}</span>
                  <span className={
                    validation.team_sides[d.demo_id] === 'CT'
                      ? teamStyles.sideCT
                      : teamStyles.sideT
                  }>
                    started as {validation.team_sides[d.demo_id]}
                  </span>
                </p>
              ))}
            </>
          )}
          {!validating && validation && !validation.ok && (
            <p className={teamStyles.validErr}>{validation.error}</p>
          )}
        </div>
      )}

      {validation?.ok && (
        <>
          <input
            type="text"
            placeholder="Session name (e.g. 'NaVi vs FaZe series')"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            className={teamStyles.nameInput}
            maxLength={80}
          />
          <button
            className={teamStyles.createBtn}
            onClick={handleCreate}
            disabled={creating || !sessionName.trim() || !allReady}
          >
            {creating ? 'Creating…' : `Create session (${readyCount + pickedFromLibrary.size} demos)`}
          </button>
        </>
      )}

      {errorMsg && <p className={teamStyles.validErr}>{errorMsg}</p>}
    </div>
  );
};

export default TeamLoader;
