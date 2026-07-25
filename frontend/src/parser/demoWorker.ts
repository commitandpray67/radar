/**
 * Demo parse Web Worker — runs the WASM parser + the TS transforms off the main
 * thread so a multi-second parse never freezes the UI.
 *
 * ⚠️ INTEGRATION — pending in-browser validation (see loadDemoparser.ts). The
 * transforms are unit-tested; the worker wiring + WASM load can only be
 * verified in a real browser with a real demo.
 *
 * Protocol:
 *   in : { id, bytes: ArrayBuffer }   (bytes transferred, not copied)
 *   out: { id, type: 'progress', fraction, message }
 *        { id, type: 'done', demo: ParsedDemo }
 *        { id, type: 'error', message }
 */

/// <reference lib="webworker" />

import { parseDemo } from './parseDemo';
import { createWasmSource } from './wasmSource';
import { loadDemoparser } from './loadDemoparser';
import { decompressDemo } from './decompress';

const ctx = self as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

ctx.onmessage = async (e: MessageEvent) => {
  const { id, bytes } = e.data as { id: number; bytes: ArrayBuffer };
  try {
    const raw = await decompressDemo(new Uint8Array(bytes));
    const mod = await loadDemoparser();
    const source = createWasmSource(mod, raw);
    const demo = parseDemo(source, {
      progress: (fraction, message) => ctx.postMessage({ id, type: 'progress', fraction, message }),
    });
    ctx.postMessage({ id, type: 'done', demo });
  } catch (err) {
    ctx.postMessage({ id, type: 'error', message: (err as Error)?.message ?? String(err) });
  }
};
