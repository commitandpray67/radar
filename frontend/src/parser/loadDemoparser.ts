/**
 * Loader for the demoparser2 WASM module.
 *
 * ⚠️ INTEGRATION — pending in-browser validation (the remaining Phase 0 runtime
 * check). The transforms + adapter are unit-tested; this module-loading glue
 * can only be verified in a real browser/worker with a real demo, which the
 * headless CI cannot do. If the pattern below needs adjusting, it is isolated
 * here — no transform code depends on how the module is obtained.
 *
 * demoparser2 is a wasm-bindgen "no-modules" build: `demoparser2.js` declares a
 * file-scoped `wasm_bindgen` and assigns it `Object.assign(init, {initSync},
 * exports)` at the end. That shape is meant for a <script> tag / classic-worker
 * importScripts, so in an ESM worker we fetch the glue text and evaluate it to
 * capture `wasm_bindgen`, then init it with the .wasm URL. In a worker
 * `typeof document === 'undefined'`, so the glue's script-path autodetect is
 * bypassed and the explicit wasm URL is used.
 *
 * CSP note: this uses `new Function` (indirect eval). The static host must not
 * set a CSP that forbids `unsafe-eval` in workers, OR switch to a classic
 * worker with importScripts. Revisit during deployment (Phase 5).
 */

import wasmUrl from 'demoparser2/demoparser2_bg.wasm?url';
import glueUrl from 'demoparser2/demoparser2.js?url';
import type { DemoparserWasm } from './wasmSource';

let cached: DemoparserWasm | null = null;

export async function loadDemoparser(): Promise<DemoparserWasm> {
  if (cached) return cached;

  const glueText = await (await fetch(glueUrl)).text();
  // The glue ends by assigning the file-scoped `wasm_bindgen`; return it out.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function(`${glueText}\n;return wasm_bindgen;`) as () => {
    (init?: unknown): Promise<unknown>;
  } & DemoparserWasm;
  const wasmBindgen = factory();
  await wasmBindgen(wasmUrl); // instantiate with the bundled .wasm asset

  cached = wasmBindgen as unknown as DemoparserWasm;
  return cached;
}
