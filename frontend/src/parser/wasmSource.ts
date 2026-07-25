/**
 * WASM-backed DemoSource — maps the `demoparser2` WASM API onto the DemoSource
 * interface the transforms consume.
 *
 * demoparser2@0.15 exports (from its .d.ts):
 *   parseEvent(file, event_name, wanted_player_props?, wanted_other_props?)
 *   parseTicks(file, wanted_props?, wanted_ticks?: Int32Array, struct_of_arrays?)
 *   parseGrenades(file)
 *   parseHeader(file)
 * All take the decompressed demo as a Uint8Array and are stateless per call
 * (the same model as the Python DemoParser, which re-reads per query).
 */

import type { DemoSource, Row, Columns } from './source';

/** The subset of the demoparser2 WASM module this adapter calls. */
export interface DemoparserWasm {
  parseHeader(file: Uint8Array): Row;
  parseEvent(file: Uint8Array, eventName: string, wantedPlayerProps?: string[], wantedOtherProps?: string[]): Row[];
  parseTicks(file: Uint8Array, wantedProps?: string[], wantedTicks?: Int32Array, structOfArrays?: boolean): Row[] | Columns;
  parseGrenades(file: Uint8Array): Row[];
}

export function createWasmSource(mod: DemoparserWasm, bytes: Uint8Array): DemoSource {
  const ticksArr = (ticks?: number[]): Int32Array | undefined =>
    ticks && ticks.length ? Int32Array.from(ticks) : undefined;

  return {
    parseHeader: () => mod.parseHeader(bytes) ?? {},
    // DemoSource passes (otherProps, playerProps); WASM wants (player, other).
    parseEvent: (name, otherProps, playerProps) =>
      (mod.parseEvent(bytes, name, playerProps ?? [], otherProps ?? []) as Row[]) ?? [],
    parseTicks: (props, ticks) =>
      (mod.parseTicks(bytes, props, ticksArr(ticks), false) as Row[]) ?? [],
    parseTicksColumnar: (props, ticks) =>
      (mod.parseTicks(bytes, props, ticksArr(ticks), true) as Columns) ?? {},
    parseGrenades: () => (mod.parseGrenades(bytes) as Row[]) ?? [],
  };
}
