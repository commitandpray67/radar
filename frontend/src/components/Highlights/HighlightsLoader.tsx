/**
 * HighlightsLoader — find one player's multi-kills across a batch of demos.
 *
 * Workflow:
 *   1. Choose the player (name or SteamID64 — before any demo is parsed), the
 *      minimum kills in a round (3K+ / 4K+ / ACE, any guns) and optionally one
 *      or more weapons plus how many of those kills must use them (e.g. Desert
 *      Eagle, at least 1 → 2 deagle + 1 AK counts as a deagle 3K).
 *   2. Drop any number of demos and/or pick cached ones from the library.
 *      All drops share one queue that parses two at a time (the backend's
 *      parse-pool size); re-dropped files are skipped.
 *   3. When a batch finishes the search runs automatically; change the filters
 *      and hit "Find highlights" to re-run without re-parsing.
 *   4. Click a highlight to open that demo at that round, just before the
 *      first kill. The results stay available in the in-app sidebar.
 *
 * The form and the batch live in useHighlightSession, so they (and uploads in
 * flight) survive this component unmounting — switching loader tabs, opening a
 * highlight, or coming back via "Load demo".
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getHighlightPlayerNames, listDemos } from '../../utils/api';
import { DEMO_ACCEPT, isAcceptedDemoFile } from '../../utils/demoFiles';
import { apiErrorMessage, searchInChunks } from '../../utils/highlights';
import { useAppStore } from '../../store/demoStore';
import type { DemoMeta } from '../../types';
import HighlightResults from './HighlightResults';
import WeaponPicker from './WeaponPicker';
import { PARSE_CONCURRENCY, sessionDemoIds, useHighlightSession } from './highlightSession';
import loaderStyles from '../DemoLoader/DemoLoader.module.css';
import teamStyles from '../DemoLoader/TeamLoader.module.css';
import styles from './Highlights.module.css';

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
  const [libraryDemos, setLibraryDemos] = useState<DemoMeta[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [knownNames, setKnownNames] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const session = useHighlightSession();
  const {
    player, weapons, minKills, minWeaponKills, picked, queue, notice, autoSearchPending,
    setPlayer, setWeapons, setMinKills, setMinWeaponKills, setPicked, removeRow, clearBatch,
    clearAutoSearch,
  } = session;

  const result = useAppStore((s) => s.highlightSearch);
  const setResult = useAppStore((s) => s.setHighlightSearch);

  useEffect(() => {
    listDemos()
      .then((d) => {
        setLibraryDemos(d.sort((a, b) => b.parsed_at.localeCompare(a.parsed_at)));
        // Picks persist across mounts; drop any demo deleted from the library since.
        const ids = new Set(d.map((x) => x.id));
        const { picked: current, setPicked: setCurrent } = useHighlightSession.getState();
        if ([...current].some((id) => !ids.has(id))) {
          setCurrent(new Set([...current].filter((id) => ids.has(id))));
        }
      })
      .catch(() => setLibraryDemos([]));
    getHighlightPlayerNames()
      .then((n) => setKnownNames(n.map((x) => x.name)))
      .catch(() => {});
  }, []);

  const addFiles = (files: FileList | File[] | null) => {
    if (files && files.length) session.addFiles(Array.from(files), isAcceptedDemoFile);
  };

  const demoIds = sessionDemoIds(session);
  const busy = queue.some((d) => d.status === 'queued' || d.status === 'uploading' || d.status === 'parsing');
  const readyCount = queue.filter((d) => d.status === 'ready').length;
  const canSearch = !busy && !searching && demoIds.length > 0 && player.trim() !== '';

  const runSearch = useCallback(async () => {
    setSearching(true);
    setErrorMsg('');
    try {
      const res = await searchInChunks({
        demo_ids: demoIds,
        player: player.trim(),
        weapons,
        min_kills: minKills,
        min_weapon_kills: Math.min(minWeaponKills, minKills),
      });
      setResult(res);
    } catch (err) {
      setErrorMsg(apiErrorMessage(err, 'Search failed'));
    } finally {
      setSearching(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoIds.join(','), player, weapons.join(','), minKills, minWeaponKills, setResult]);

  // A finished batch is searched automatically, once — as soon as nothing is
  // parsing or searching (also after this component remounts). The flag is
  // read live from the store so StrictMode's double-run of the mount effect
  // sees it already cleared. If the batch was cleared meanwhile, disarm it.
  useEffect(() => {
    if (!useHighlightSession.getState().autoSearchPending) return;
    if (canSearch) {
      clearAutoSearch();
      runSearch();
    } else if (!busy && !searching && demoIds.length === 0) {
      clearAutoSearch();
    }
  }, [autoSearchPending, canSearch, busy, searching, demoIds.length, runSearch, clearAutoSearch]);

  const togglePicked = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const onDrop = (e: React.DragEvent) => {
    // Keep the outer loader's drop handler from also receiving these files.
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className={teamStyles.root}>
      <p className={teamStyles.intro}>
        Pick a player, then drop a batch of demos — every round where they hit a
        multi-kill (optionally using the chosen weapons) is listed, ready to replay.
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
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Kills in a round (any guns)</span>
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
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Weapons</span>
          <WeaponPicker selected={weapons} onChange={setWeapons} />
        </div>
        {weapons.length > 0 && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>
              At least this many of the kills with {weapons.length > 1 ? 'these weapons' : 'this weapon'}
            </span>
            <div className={styles.chips}>
              {Array.from({ length: minKills }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  className={`${styles.chip} ${Math.min(minWeaponKills, minKills) === n ? styles.chipActive : ''}`}
                  onClick={() => setMinWeaponKills(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
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
                    onClick={() => removeRow(d.uid)}
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

      {demoIds.length > 0 && (
        <p className={styles.queueSummary}>
          {demoIds.length} demo{demoIds.length !== 1 ? 's' : ''} selected
          {' '}({readyCount} uploaded, {picked.size} from library)
          {' · '}
          <button type="button" className={styles.linkBtn} onClick={clearBatch}>
            Clear
          </button>
        </p>
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

      {(errorMsg || notice) && <p className={teamStyles.validErr}>{[notice, errorMsg].filter(Boolean).join(' ')}</p>}

      {result && <HighlightResults result={result} onOpened={onComplete} />}
    </div>
  );
};

export default HighlightsLoader;
