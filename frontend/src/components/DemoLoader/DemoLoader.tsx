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
import {
  uploadDemo,
  watchParseStatus,
  getRounds,
  getPlayers,
  getPositions,
  getEvents,
  getGrenades,
  getPlayerStateEvents,
  getMaps,
} from '../../utils/api';
import type { ParseJobStatus } from '../../types';
import styles from './DemoLoader.module.css';

type LoadPhase =
  | 'idle'
  | 'uploading'
  | 'parsing'
  | 'fetching'
  | 'cached'      // loaded from cache — offer re-parse
  | 'done'
  | 'error';

const DemoLoader: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [phase, setPhase] = useState<LoadPhase>('idle');
  const [parseStatus, setParseStatus] = useState<ParseJobStatus | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const setDemo              = useAppStore((s) => s.setDemo);
  const setRounds            = useAppStore((s) => s.setRounds);
  const setPlayers           = useAppStore((s) => s.setPlayers);
  const setPositions         = useAppStore((s) => s.setPositions);
  const setEvents            = useAppStore((s) => s.setEvents);
  const setGrenades          = useAppStore((s) => s.setGrenades);
  const setPlayerStateEvents = useAppStore((s) => s.setPlayerStateEvents);
  const setMaps              = useAppStore((s) => s.setMaps);
  const setCurrentMap        = useAppStore((s) => s.setCurrentMap);
  const setParseStatusStore  = useAppStore((s) => s.setParseStatus);
  const setActiveRound       = useAppStore((s) => s.setActiveRound);
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
      if (!file.name.toLowerCase().endsWith('.dem')) {
        setErrorMsg('Please select a valid CS2 .dem demo file.');
        setPhase('error');
        return;
      }

      setPhase('uploading');
      setErrorMsg('');
      setParseStatus(null);

      try {
        // 1. Upload
        const { job_id, demo_id, cached } = await uploadDemo(file, (pct) => {
          setUploadProgress(pct);
        }, force);

        // 2. Watch parse status via SSE (skipped when loaded from valid cache)
        if (!cached) {
          setPhase('parsing');
          await watchParseStatus(job_id, (status) => {
            setParseStatus(status);
            setParseStatusStore(status);
          });
        }

        // 3. Fetch all data
        setPhase('fetching');
        const [rounds, players, positions, events, grenades, playerStateEvts, freshMaps] =
          await Promise.all([
            getRounds(demo_id),
            getPlayers(demo_id),
            getPositions(demo_id),
            getEvents(demo_id),
            getGrenades(demo_id),
            getPlayerStateEvents(demo_id),
            cached ? Promise.resolve(maps) : getMaps(),
          ]);

        setRounds(rounds);
        setPlayers(players);
        setPositions(positions);
        setEvents(events);
        setGrenades(grenades);
        setPlayerStateEvents(playerStateEvts);
        if (!cached) setMaps(freshMaps);

        // Set current map calibration
        // Fetch accurate demo metadata from the server
        const { getDemo } = await import('../../utils/api');
        const freshDemo = await getDemo(demo_id);
        setDemo(freshDemo);

        const mapMeta = (cached ? maps : freshMaps).find(
          (m) => m.name === freshDemo.map_name,
        );
        setCurrentMap(mapMeta ?? null);

        // Jump to round 1
        if (rounds.length > 0) {
          setActiveRound(rounds[0].round_number);
        }

        setPhase('done');
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
        setPhase('error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maps],
  );


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
      <div className={styles.card}>
        <div className={styles.logo}>CS2 Radar</div>
        <p className={styles.subtitle}>Demo analysis tool</p>

        {phase === 'idle' && (
          <>
            <div
              className={styles.dropZone}
              onClick={() => inputRef.current?.click()}
            >
              <span className={styles.dropIcon}>📁</span>
              <p className={styles.dropText}>
                Drag &amp; drop a <code>.dem</code> file here
              </p>
              <p className={styles.dropHint}>or click to browse</p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".dem"
              className={styles.hiddenInput}
              onChange={onFileChange}
            />
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
