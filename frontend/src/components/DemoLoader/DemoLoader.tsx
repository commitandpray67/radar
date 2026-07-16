/**
 * DemoLoader — full-screen drag-and-drop file picker.
 *
 * On drop / file select:
 *  1. Upload the .dem file to the backend
 *  2. Open an SSE stream to track parse progress
 *  3. On completion, fetch rounds, players, and positions
 *  4. Populate the Zustand store and transition to the radar view
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAppStore } from '../../store/demoStore';
import { getMaps } from '../../utils/api';
import { loadDemoIntoStore, uploadAndParse } from '../../utils/demoLoading';
import type { ParseJobStatus } from '../../types';
import { DEMO_ACCEPT, isAcceptedDemoFile } from '../../utils/demoFiles';
import DemoLibrary from '../DemoLibrary/DemoLibrary';
import TeamLoader from './TeamLoader';
import TeamSessionLibrary from './TeamSessionLibrary';
import TeamOrganizer from './TeamOrganizer';
import FaceitLoader from './FaceitLoader';
import styles from './DemoLoader.module.css';

type LoadPhase =
  | 'idle'
  | 'uploading'
  | 'parsing'
  | 'fetching'
  | 'cached'      // loaded from cache — offer re-parse
  | 'done'
  | 'error';

type LoaderTab = 'single' | 'team' | 'teams' | 'faceit';

const DemoLoader: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [phase, setPhase] = useState<LoadPhase>('idle');
  const [parseStatus, setParseStatus] = useState<ParseJobStatus | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [showLibrary, setShowLibrary] = useState(false);
  const [tab, setTab] = useState<LoaderTab>('single');
  const [showTeamLibrary, setShowTeamLibrary] = useState(false);
  const [faceitWide, setFaceitWide] = useState(false);
  const parseAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => parseAbortRef.current?.abort(), []);

  const setMaps              = useAppStore((s) => s.setMaps);
  const setParseStatusStore  = useAppStore((s) => s.setParseStatus);
  const maps                 = useAppStore((s) => s.maps);

  // Preload maps on mount
  useEffect(() => {
    getMaps()
      .then((m) => setMaps(m))
      .catch(() => {/* server not ready yet */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processFile = useCallback(
    async (file: File, force = false) => {
      if (!isAcceptedDemoFile(file.name)) {
        setErrorMsg('Please select a CS2 .dem demo (or a .dem.zst / .dem.gz archive).');
        setPhase('error');
        return;
      }

      setPhase('uploading');
      setErrorMsg('');
      setParseStatus(null);
      parseAbortRef.current?.abort();
      const controller = new AbortController();
      parseAbortRef.current = controller;

      try {
        // 1-2. Upload + watch parse (skipped when loaded from valid cache).
        const { demoId, cached } = await uploadAndParse(file, {
          force,
          signal: controller.signal,
          onUploadProgress: setUploadProgress,
          onParseStatus: (status) => {
            setPhase('parsing');
            setParseStatus(status);
            setParseStatusStore(status);
          },
        });

        // 3. Load everything into the store (guarded by loadDemoIntoStore's
        //    monotonic token + AbortController).
        setPhase('fetching');
        const freshMaps = cached && maps.length ? maps : await getMaps();
        if (!cached) setMaps(freshMaps);
        await loadDemoIntoStore(demoId, { maps: freshMaps });

        setPhase('done');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
        setPhase('error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maps],
  );


  // Load a previously parsed demo directly from the library (by demo_id)
  const loadFromLibrary = useCallback(async (demoId: string) => {
    setPhase('fetching');
    setErrorMsg('');
    try {
      const freshMaps = await getMaps();
      setMaps(freshMaps);
      await loadDemoIntoStore(demoId, { maps: freshMaps });
      setPhase('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load demo');
      setPhase('error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag-and-drop handlers
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const onDragLeave = () => setIsDragOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const resetLoader = () => {
    setPhase('idle');
    setErrorMsg('');
    setParseStatus(null);
    setUploadProgress(0);
    if (inputRef.current) inputRef.current.value = '';
  };

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (phase === 'done') return null;

  const progressFraction =
    phase === 'uploading'
      ? uploadProgress * 0.15  // upload = 0–15%
      : parseStatus?.progress ?? 0;

  const statusMessage =
    phase === 'uploading'
      ? `Uploading… ${Math.round(uploadProgress * 100)}%`
      : phase === 'fetching'
      ? 'Fetching match data…'
      : parseStatus?.message ?? '';

  return (
    <div
      className={`${styles.root} ${isDragOver ? styles.dragOver : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={`${styles.card} ${faceitWide && tab === 'faceit' ? styles.cardWide : ''}`}>
        <div className={styles.logo}>CS2 Radar</div>
        <p className={styles.subtitle}>Demo analysis tool</p>

        {phase === 'idle' && (
          <>
            <div className={styles.tabBar}>
              <button
                className={`${styles.tab} ${tab === 'single' ? styles.activeTab : ''}`}
                onClick={() => setTab('single')}
              >
                Single demo
              </button>
              <button
                className={`${styles.tab} ${tab === 'team' ? styles.activeTab : ''}`}
                onClick={() => setTab('team')}
              >
                Team analysis
              </button>
              <button
                className={`${styles.tab} ${tab === 'teams' ? styles.activeTab : ''}`}
                onClick={() => setTab('teams')}
              >
                Teams
              </button>
              <button
                className={`${styles.tab} ${tab === 'faceit' ? styles.activeTab : ''}`}
                onClick={() => setTab('faceit')}
              >
                FACEIT
              </button>
            </div>

            {tab === 'single' && (
              <>
                <div
                  className={styles.dropZone}
                  onClick={() => inputRef.current?.click()}
                >
                  <span className={styles.dropIcon}>📁</span>
                  <p className={styles.dropText}>
                    Drag &amp; drop a <code>.dem</code> file here
                  </p>
                  <p className={styles.dropHint}>
                    or click to browse — <code>.dem.zst</code> / <code>.dem.gz</code> ok too
                  </p>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept={DEMO_ACCEPT}
                  className={styles.hiddenInput}
                  onChange={onFileChange}
                />
                <button
                  className={styles.libraryToggle}
                  onClick={() => setShowLibrary((s) => !s)}
                >
                  {showLibrary ? 'Hide library' : 'Load from library'}
                </button>
                {showLibrary && (
                  <DemoLibrary onLoad={loadFromLibrary} />
                )}
              </>
            )}

            {tab === 'team' && (
              <>
                <TeamLoader onComplete={() => setPhase('done')} />
                <button
                  className={styles.libraryToggle}
                  onClick={() => setShowTeamLibrary((s) => !s)}
                >
                  {showTeamLibrary ? 'Hide saved sessions' : 'Load saved session'}
                </button>
                {showTeamLibrary && (
                  <TeamSessionLibrary onLoaded={() => setPhase('done')} />
                )}
              </>
            )}

            {tab === 'teams' && (
              <TeamOrganizer onSessionLoaded={() => setPhase('done')} />
            )}

            {tab === 'faceit' && (
              <FaceitLoader
                onComplete={() => setPhase('done')}
                onExpand={setFaceitWide}
              />
            )}
          </>
        )}

        {(phase === 'uploading' || phase === 'parsing' || phase === 'fetching') && (
          <div className={styles.progressWrapper}>
            <div className={styles.progressBar}>
              <div
                className={styles.progressFill}
                style={{ width: `${Math.round(progressFraction * 100)}%` }}
              />
            </div>
            <p className={styles.progressMsg}>{statusMessage}</p>
            {parseStatus && (
              <p className={styles.progressSub}>
                {parseStatus.filename}
                {parseStatus.map_name ? ` — ${parseStatus.map_name}` : ''}
              </p>
            )}
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.error}>
            <p className={styles.errorMsg}>{errorMsg}</p>
            <button className={styles.retryBtn} onClick={resetLoader}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default DemoLoader;
