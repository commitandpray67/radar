/**
 * HighlightsLoader — find one player's multi-kills across a batch of demos.
 *
 * Workflow:
 *   1. Choose the player (name or SteamID64 — before any demo is parsed), the
 *      weapon (e.g. Desert Eagle) and the minimum kills (3K+ / 4K+ / ACE).
 *   2. Drop any number of demos and/or pick cached ones from the library.
 *      Uploads parse two at a time (the backend's parse-pool size).
 *   3. When every demo is ready the search runs automatically; change the
 *      filters and hit "Find highlights" to re-run without re-parsing.
 *   4. Click a highlight to open that demo at that round, just before the
 *      first kill. The results stay available in the in-app sidebar.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getHighlightPlayerNames, listDemos, searchHighlights } from '../../utils/api';
import { uploadAndParse } from '../../utils/demoLoading';
import { DEMO_ACCEPT, isAcceptedDemoFile } from '../../utils/demoFiles';
import { HIGHLIGHT_WEAPONS, runWithConcurrency } from '../../utils/highlights';
import { useAppStore } from '../../store/demoStore';
import type { DemoMeta, ParseJobStatus } from '../../types';
import HighlightResults from './HighlightResults';
import loaderStyles from '../DemoLoader/DemoLoader.module.css';
import teamStyles from '../DemoLoader/TeamLoader.module.css';
import styles from './Highlights.module.css';

interface QueuedDemo {
  uid: string;
  file: File;
  demo_id: string;
  status: 'queued' | 'uploading' | 'parsing' | 'ready' | 'error';
  progress: number;    // 0..1
  error?: string;
}

/** Demos parsed at once — matches the backend's parse pool. */
const PARSE_CONCURRENCY = 2;

const MIN_KILL_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [3, '3K+'],
  [4, '4K+'],
  [5, 'ACE'],
];

interface Props {
  onComplete: () => void;   // a highlight was opened
}

const HighlightsLoader: React.FC<Props> = ({ onComplete }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [player, setPlayer] = useState('');
  const [weapon, setWeapon] = useState('deagle');
  const [minKills, setMinKills] = useState(3);
  const [queue, setQueue] = useState<QueuedDemo[]>([]);
  const [libraryDemos, setLibraryDemos] = useState<DemoMeta[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showLibrary, setShowLibrary] = useState(false);
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const result = useAppStore((s) => s.highlightSearch);
  const setResult = useAppStore((s) => s.setHighlightSearch);

  useEffect(() => {
    listDemos()
      .then((d) => setLibraryDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at))))
      .catch(() => setLibraryDemos([]));
    getHighlightPlayerNames()
      .then((n) => setKnownNames(n.map((x) => x.name)))
      .catch(() => {});
    // Restore the previous search's filters when coming back to the loader.
    const prev = useAppStore.getState().highlightSearch;
    if (prev) {
      setPlayer(prev.player);
      setWeapon(prev.weapons[0] ?? '');
      setMinKills(prev.min_kills);
    }
    return () => abortRef.current?.abort();
  }, []);

  const patch = (uid: string, p: Partial<QueuedDemo>) =>
    setQueue((prev) => prev.map((d) => (d.uid === uid ? { ...d, ...p } : d)));

  const parseOne = useCallback(async (item: QueuedDemo) => {
    if (!abortRef.current) abortRef.current = new AbortController();
    patch(item.uid, { status: 'uploading' });
    try {
      const { demoId } = await uploadAndParse(item.file, {
        signal: abortRef.current.signal,
        onUploadProgress: (pct) => patch(item.uid, { progress: pct * 0.15 }),
        onParseStatus: (s: ParseJobStatus) =>
          patch(item.uid, { status: 'parsing', progress: s.progress }),
      });
      patch(item.uid, { status: 'ready', progress: 1, demo_id: demoId });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      patch(item.uid, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files);
    const bad = list.filter((f) => !isAcceptedDemoFile(f.name));
    setErrorMsg(bad.length
      ? `Skipped ${bad.length} non-demo file(s): ${bad.map((f) => f.name).join(', ')}`
      : '');
    const items: QueuedDemo[] = list
      .filter((f) => isAcceptedDemoFile(f.name))
      .map((file) => ({
        uid: crypto.randomUUID(),
        file,
        demo_id: '',
        status: 'queued',
        progress: 0,
      }));
    if (items.length === 0) return;
    setQueue((prev) => [...prev, ...items]);
    await runWithConcurrency(items, PARSE_CONCURRENCY, parseOne);
  };

  const demoIds = Array.from(new Set([
    ...queue.filter((d) => d.status === 'ready').map((d) => d.demo_id),
    ...picked,
  ]));
  const busy = queue.some((d) => d.status === 'queued' || d.status === 'uploading' || d.status === 'parsing');
  const readyCount = queue.filter((d) => d.status === 'ready').length;
  const canSearch = !busy && !searching && demoIds.length > 0 && player.trim() !== '';

  const runSearch = useCallback(async () => {
    setSearching(true);
    setErrorMsg('');
    try {
      const res = await searchHighlights({
        demo_ids: demoIds,
        player: player.trim(),
        weapons: weapon ? [weapon] : [],
        min_kills: minKills,
      });
      setResult(res);
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: unknown } } })
        ?.response?.data?.detail ?? (err as Error)?.message ?? 'Search failed';
      setErrorMsg(typeof msg === 'string' ? msg : 'Search failed — check the inputs');
    } finally {
      setSearching(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoIds.join(','), player, weapon, minKills, setResult]);

  // Search automatically when a batch of uploads finishes parsing (busy → idle),
  // so a 20-demo drop needs no further clicks.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy && canSearch) runSearch();
    wasBusy.current = busy;
  }, [busy, canSearch, runSearch]);

  const togglePicked = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const onDrop = (e: React.DragEvent) => {
    // Keep the outer loader's single-demo drop handler from firing too.
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className={teamStyles.root}>
      <p className={teamStyles.intro}>
        Pick a player, then drop a batch of demos — every round where they hit a
        multi-kill with the chosen weapon is listed, ready to replay.
      </p>

      <div className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Player</span>
          <input
            type="text"
            list="highlight-player-names"
            placeholder="Nickname or SteamID64"
            value={player}
            onChange={(e) => setPlayer(e.target.value)}
            className={teamStyles.nameInput}
            maxLength={64}
          />
          <datalist id="highlight-player-names">
            {knownNames.map((n) => <option key={n} value={n} />)}
          </datalist>
        </label>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Weapon</span>
            <select
              className={styles.select}
              value={weapon}
              onChange={(e) => setWeapon(e.target.value)}
            >
              {HIGHLIGHT_WEAPONS.map(([token, label]) => (
                <option key={token || 'any'} value={token}>{label}</option>
              ))}
            </select>
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Kills in a round</span>
            <div className={styles.chips}>
              {MIN_KILL_OPTIONS.map(([n, label]) => (
                <button
                  key={n}
                  className={`${styles.chip} ${minKills === n ? styles.chipActive : ''}`}
                  onClick={() => setMinKills(n)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        className={`${loaderStyles.dropZone} ${styles.dropZone} ${isDragOver ? styles.dropZoneOver : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
      >
        <p className={loaderStyles.dropText}>Drop demos here (as many as you like)</p>
        <p className={loaderStyles.dropHint}>
          or click to browse — <code>.dem</code> / <code>.dem.zst</code> / <code>.dem.gz</code>
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={DEMO_ACCEPT}
        multiple
        className={loaderStyles.hiddenInput}
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
      />

      {queue.length > 0 && (
        <>
          <p className={styles.queueSummary}>
            {readyCount}/{queue.length} parsed
            {busy && ` — parsing ${PARSE_CONCURRENCY} at a time…`}
          </p>
          <div className={teamStyles.demoList}>
            {queue.map((d) => (
              <div key={d.uid} className={teamStyles.demoRow}>
                <span className={teamStyles.demoName}>{d.file.name}</span>
                <span className={teamStyles.demoStatus} title={d.error}>
                  {d.status === 'queued' && 'Queued'}
                  {d.status === 'uploading' && `Uploading ${Math.round(d.progress * 100)}%`}
                  {d.status === 'parsing' && `Parsing ${Math.round(d.progress * 100)}%`}
                  {d.status === 'ready' && '✓'}
                  {d.status === 'error' && 'Failed'}
                </span>
                {(d.status === 'ready' || d.status === 'error') && (
                  <button
                    className={teamStyles.removeBtn}
                    onClick={() => setQueue((prev) => prev.filter((x) => x.uid !== d.uid))}
                    title="Remove"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <button
        className={loaderStyles.libraryToggle}
        onClick={() => setShowLibrary((s) => !s)}
      >
        {showLibrary
          ? 'Hide library'
          : `Pick from library (${picked.size}/${libraryDemos.length})`}
      </button>
      {showLibrary && (
        <div className={teamStyles.libraryList}>
          {libraryDemos.length === 0 && <p className={teamStyles.empty}>No cached demos yet.</p>}
          {libraryDemos.length > 0 && (
            <label className={teamStyles.libRow}>
              <input
                type="checkbox"
                checked={picked.size === libraryDemos.length}
                onChange={(e) => setPicked(e.target.checked
                  ? new Set(libraryDemos.map((d) => d.id))
                  : new Set())}
              />
              <span className={teamStyles.libName}>All</span>
            </label>
          )}
          {libraryDemos.map((d) => (
            <label key={d.id} className={teamStyles.libRow}>
              <input
                type="checkbox"
                checked={picked.has(d.id)}
                onChange={() => togglePicked(d.id)}
              />
              <span className={teamStyles.libName}>{d.filename}</span>
              <span className={teamStyles.libMeta}>{d.map_name}</span>
            </label>
          ))}
        </div>
      )}

      <button
        className={teamStyles.createBtn}
        onClick={runSearch}
        disabled={!canSearch}
      >
        {searching
          ? 'Searching…'
          : busy
          ? 'Waiting for demos to parse…'
          : `Find highlights (${demoIds.length} demo${demoIds.length !== 1 ? 's' : ''})`}
      </button>

      {errorMsg && <p className={teamStyles.validErr}>{errorMsg}</p>}

      {result && <HighlightResults result={result} onOpened={onComplete} />}
    </div>
  );
};

export default HighlightsLoader;
