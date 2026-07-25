/**
 * Main-thread client for the demo parse worker.
 *
 * Spawns the Web Worker, transfers the demo bytes, relays progress, and
 * resolves with the ParsedDemo. Phase 2 wires this into demoLoading.ts in
 * place of the HTTP upload+parse flow.
 */

import type { ParsedDemo, ProgressFn } from './types';

export function parseDemoInWorker(
  bytes: ArrayBuffer,
  opts: { onProgress?: ProgressFn; signal?: AbortSignal } = {},
): Promise<ParsedDemo> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./demoWorker.ts', import.meta.url), {
      type: 'module',
      name: 'demo-parser',
    });
    const id = 1;
    let settled = false;
    const done = () => {
      settled = true;
      worker.terminate();
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort);

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as
        | { type: 'progress'; fraction: number; message: string }
        | { type: 'done'; demo: ParsedDemo }
        | { type: 'error'; message: string };
      if (m.type === 'progress') opts.onProgress?.(m.fraction, m.message);
      else if (m.type === 'done') { done(); resolve(m.demo); }
      else if (m.type === 'error') { done(); reject(new Error(m.message)); }
    };
    worker.onerror = (e) => {
      if (settled) return;
      done();
      reject(new Error(e.message || 'Demo parse worker crashed'));
    };

    // Transfer the ArrayBuffer (zero-copy) into the worker.
    worker.postMessage({ id, bytes }, [bytes]);
  });
}
