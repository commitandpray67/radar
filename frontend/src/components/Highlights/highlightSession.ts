/**
 * highlightSession — the Highlights loader's form and upload batch.
 *
 * Kept outside the component so they survive it unmounting: switching loader
 * tabs, opening a highlight, or coming back via "Load demo" never loses the
 * filters or the batch. Uploads keep going in the background, at most
 * PARSE_CONCURRENCY at a time, across every drop. The same queue also
 * re-parses cached demos from their stored file (to update demos parsed by an
 * older parser version).
 */

import { create } from 'zustand';
import { reparseAndWait, uploadAndParse } from '../../utils/demoLoading';
import { apiErrorMessage } from '../../utils/highlights';
import type { ParseJobStatus } from '../../types';

export interface QueuedDemo {
  uid: string;
  name: string;        // shown in the list
  file?: File;         // an upload…
  reparseId?: string;  // …or a cached demo to re-parse from its stored file
  fileKey: string;     // name|size|mtime (or reparse|id) — dedupes re-adds
  demo_id: string;
  status: 'queued' | 'uploading' | 'parsing' | 'ready' | 'error';
  progress: number;    // 0..1 of the current step (upload, then parse)
  error?: string;
}

/** Demos parsed at once — matches the backend's parse pool. */
export const PARSE_CONCURRENCY = 2;

interface HighlightSession {
  player: string;
  weapons: string[];
  minKills: number;
  minWeaponKills: number;
  /** Cached demos ticked in the library list. */
  picked: Set<string>;
  queue: QueuedDemo[];
  /** Message about the last drop (skipped / duplicate files). */
  notice: string;
  /** A batch finished: the loader runs the search (once) when it can. */
  autoSearchPending: boolean;

  setPlayer: (player: string) => void;
  setWeapons: (weapons: string[]) => void;
  setMinKills: (n: number) => void;
  setMinWeaponKills: (n: number) => void;
  setPicked: (picked: Set<string>) => void;
  addFiles: (files: File[], accept: (name: string) => boolean) => void;
  /** Queue cached demos for a re-parse from their stored file. */
  reparseDemos: (demos: { id: string; filename: string }[]) => void;
  removeRow: (uid: string) => void;
  /** Forget finished rows and library picks (uploads in flight carry on). */
  clearBatch: () => void;
  clearAutoSearch: () => void;
}

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
export const reparseKey = (demoId: string) => `reparse|${demoId}`;
const isLive = (d: QueuedDemo) => d.status !== 'ready' && d.status !== 'error';

/** demo_ids a search would cover: parsed uploads plus library picks. */
export function sessionDemoIds(s: Pick<HighlightSession, 'queue' | 'picked'>): string[] {
  return Array.from(new Set([
    ...s.queue.filter((d) => d.status === 'ready').map((d) => d.demo_id),
    ...s.picked,
  ]));
}

let seq = 0;
let active = 0;
const pending: QueuedDemo[] = [];

export const useHighlightSession = create<HighlightSession>()((set, get) => {
  const patch = (uid: string, p: Partial<QueuedDemo>) =>
    set((s) => ({ queue: s.queue.map((d) => (d.uid === uid ? { ...d, ...p } : d)) }));

  const parseOne = async (item: QueuedDemo) => {
    const onParseStatus = (st: ParseJobStatus) =>
      patch(item.uid, { status: 'parsing', progress: st.progress });
    patch(item.uid, { status: item.file ? 'uploading' : 'parsing', progress: 0 });
    try {
      const { demoId } = item.file
        ? await uploadAndParse(item.file, {
          onUploadProgress: (pct) => patch(item.uid, { progress: pct }),
          onParseStatus,
        })
        : await reparseAndWait(item.reparseId!, { onParseStatus });
      patch(item.uid, { status: 'ready', progress: 1, demo_id: demoId });
    } catch (err) {
      patch(item.uid, {
        status: 'error',
        error: apiErrorMessage(err, item.file ? 'Upload failed' : 'Update failed'),
      });
    }
  };

  const enqueue = (items: QueuedDemo[]) => {
    pending.push(...items);
    pump();
  };

  const pump = () => {
    while (active < PARSE_CONCURRENCY && pending.length) {
      const item = pending.shift()!;
      active += 1;
      parseOne(item).finally(() => {
        active -= 1;
        pump();
        if (active === 0 && pending.length === 0) {
          // Batch done: search it — only with a player entered (so the search
          // never fires on a keystroke later) and something to search.
          const s = get();
          if (s.player.trim() && sessionDemoIds(s).length) set({ autoSearchPending: true });
        }
      });
    }
  };

  return {
    player: '',
    weapons: ['deagle'],
    minKills: 3,
    minWeaponKills: 1,
    picked: new Set(),
    queue: [],
    notice: '',
    autoSearchPending: false,

    setPlayer: (player) =>
      set(player.trim() ? { player } : { player, autoSearchPending: false }),
    setWeapons: (weapons) => set({ weapons }),
    setMinKills: (minKills) => set({ minKills }),
    setMinWeaponKills: (minWeaponKills) => set({ minWeaponKills }),
    setPicked: (picked) => set({ picked }),

    addFiles: (files, accept) => {
      const { queue } = get();
      const taken = new Set(queue.filter((d) => d.status !== 'error').map((d) => d.fileKey));
      const bad = files.filter((f) => !accept(f.name));
      const fresh: File[] = [];
      for (const f of files) {
        if (!accept(f.name) || taken.has(fileKey(f))) continue;
        taken.add(fileKey(f));
        fresh.push(f);
      }
      const dupes = files.length - bad.length - fresh.length;
      const items: QueuedDemo[] = fresh.map((file) => ({
        uid: `q${++seq}`,
        name: file.name,
        file,
        fileKey: fileKey(file),
        demo_id: '',
        status: 'queued',
        progress: 0,
      }));
      set({
        queue: [...queue, ...items],
        notice: [
          bad.length ? `Skipped ${bad.length} non-demo file(s): ${bad.map((f) => f.name).join(', ')}` : '',
          dupes ? `Skipped ${dupes} file(s) already in the list.` : '',
        ].filter(Boolean).join(' '),
      });
      enqueue(items);
    },

    reparseDemos: (demos) => {
      const { queue } = get();
      const taken = new Set(queue.filter((d) => d.status !== 'error').map((d) => d.fileKey));
      const items: QueuedDemo[] = demos
        .filter((d) => !taken.has(reparseKey(d.id)))
        .map((d) => ({
          uid: `q${++seq}`,
          name: d.filename,
          reparseId: d.id,
          fileKey: reparseKey(d.id),
          demo_id: '',
          status: 'queued',
          progress: 0,
        }));
      if (items.length === 0) return;
      set({ queue: [...queue, ...items] });
      enqueue(items);
    },

    removeRow: (uid) => set((s) => ({ queue: s.queue.filter((d) => d.uid !== uid || isLive(d)) })),
    clearBatch: () => set((s) => ({
      queue: s.queue.filter(isLive),
      picked: new Set(),
      notice: '',
      autoSearchPending: false,
    })),
    clearAutoSearch: () => set({ autoSearchPending: false }),
  };
});
