import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable fake uploads: each call waits until the test resolves it.
const calls: { name: string; resolve: () => void; reject: (e: Error) => void }[] = [];
vi.mock('../../utils/demoLoading', () => ({
  uploadAndParse: (file: File) =>
    new Promise<{ demoId: string; cached: boolean }>((resolve, reject) => {
      calls.push({
        name: file.name,
        resolve: () => resolve({ demoId: `id-${file.name}`, cached: false }),
        reject,
      });
    }),
}));

import { PARSE_CONCURRENCY, sessionDemoIds, useHighlightSession } from './highlightSession';

const file = (name: string) => new File(['x'], name, { lastModified: 1 });
const accept = (n: string) => n.endsWith('.dem');
const flush = () => new Promise((r) => setTimeout(r, 0));
const status = () => useHighlightSession.getState().queue.map((d) => `${d.file.name}:${d.status}`);

beforeEach(async () => {
  // Drain anything still in flight from a previous test, then reset.
  while (calls.length) { calls.shift()!.resolve(); await flush(); }
  useHighlightSession.setState({ queue: [], picked: new Set(), player: '', notice: '', autoSearchPending: false });
});

describe('highlight upload session', () => {
  it('runs every drop through one queue, PARSE_CONCURRENCY at a time', async () => {
    const s = useHighlightSession.getState();
    s.addFiles([file('a.dem'), file('b.dem'), file('c.dem')], accept);
    s.addFiles([file('d.dem'), file('e.dem')], accept);
    await flush();
    expect(calls).toHaveLength(PARSE_CONCURRENCY);
    calls.shift()!.resolve();
    await flush();
    expect(calls).toHaveLength(PARSE_CONCURRENCY); // the next one started
    expect(status()).toEqual(['a.dem:ready', 'b.dem:uploading', 'c.dem:uploading', 'd.dem:queued', 'e.dem:queued']);
  });

  it('skips duplicates and non-demo files, and reports them', () => {
    const s = useHighlightSession.getState();
    s.addFiles([file('a.dem'), file('notes.txt')], accept);
    s.addFiles([file('a.dem')], accept);
    expect(useHighlightSession.getState().queue).toHaveLength(1);
    expect(useHighlightSession.getState().notice).toBe('Skipped 1 file(s) already in the list.');
  });

  it('arms the auto-search when a batch finishes with a player entered', async () => {
    const s = useHighlightSession.getState();
    s.setPlayer('Qiyarah');
    s.addFiles([file('a.dem'), file('b.dem')], accept);
    await flush();
    calls.shift()!.resolve();
    await flush();
    expect(useHighlightSession.getState().autoSearchPending).toBe(false); // b still running
    calls.shift()!.resolve();
    await flush();
    expect(useHighlightSession.getState().autoSearchPending).toBe(true);
    expect(sessionDemoIds(useHighlightSession.getState())).toEqual(['id-a.dem', 'id-b.dem']);
  });

  it('does not arm the auto-search without a player', async () => {
    useHighlightSession.getState().addFiles([file('a.dem')], accept);
    await flush();
    calls.shift()!.resolve();
    await flush();
    expect(useHighlightSession.getState().autoSearchPending).toBe(false);
  });

  it('lets a failed file be retried, and removing the failed row keeps the retry deduped', async () => {
    const s = useHighlightSession.getState();
    s.addFiles([file('a.dem')], accept);
    await flush();
    calls.shift()!.reject(new Error('network'));
    await flush();
    s.addFiles([file('a.dem')], accept); // retry is allowed
    await flush();
    calls.shift()!.resolve();
    await flush();
    const failed = useHighlightSession.getState().queue.find((d) => d.status === 'error')!;
    s.removeRow(failed.uid);
    s.addFiles([file('a.dem')], accept); // still a duplicate of the ready row
    expect(status()).toEqual(['a.dem:ready']);
  });

  it('clearBatch forgets finished rows and picks but keeps uploads in flight', async () => {
    const s = useHighlightSession.getState();
    s.setPicked(new Set(['lib1']));
    s.addFiles([file('a.dem'), file('b.dem'), file('c.dem')], accept);
    await flush();
    calls.shift()!.resolve();
    await flush();
    s.clearBatch();
    expect(status()).toEqual(['b.dem:uploading', 'c.dem:uploading']);
    expect(useHighlightSession.getState().picked.size).toBe(0);
  });
});

describe('highlight upload session — auto-search disarm', () => {
  it('clearBatch disarms a pending auto-search', async () => {
    const s = useHighlightSession.getState();
    s.setPlayer('Qiyarah');
    s.addFiles([file('z.dem')], accept);
    await flush();
    calls.shift()!.resolve();
    await flush();
    expect(useHighlightSession.getState().autoSearchPending).toBe(true);
    s.clearBatch();
    expect(useHighlightSession.getState().autoSearchPending).toBe(false);
  });
});
