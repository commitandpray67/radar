/**
 * DemoSource — the abstraction the parser transforms run against.
 *
 * It mirrors the surface of the Python `demoparser2` object
 * (`parse_header` / `parse_event` / `parse_ticks` / `parse_grenades`) so the
 * porting of `backend/parser/*.py` stays close to the original. The real
 * implementation wraps the `demoparser2` WASM module (see `wasmSource.ts`);
 * tests inject a fake, so every transform is unit-testable without the WASM.
 *
 * demoparser2 argument mapping (Python → WASM → this interface):
 *   parse_event(name, other=[...], player=[...])
 *     → parseEvent(bytes, name, wanted_player_props, wanted_other_props)
 *     → parseEvent(name, otherProps, playerProps)
 *   Per-player props come back prefixed `user_` (e.g. `user_X`), matching the
 *   Python code which reads `row.get("user_X")`.
 */

export type Row = Record<string, unknown>;
export type Columns = Record<string, unknown[]>;

export interface DemoSource {
  /** Header dict: map_name, playback_ticks, playback_time. */
  parseHeader(): Row;
  /**
   * Named game event → array of row objects.
   * @param otherProps  non-player event columns (tick, winner, reason, …)
   * @param playerProps per-player columns; returned prefixed `user_`
   */
  parseEvent(name: string, otherProps?: string[], playerProps?: string[]): Row[];
  /** Per-tick entity/prop sampling as an array of row objects. */
  parseTicks(props: string[], ticks?: number[]): Row[];
  /** Per-tick sampling as struct-of-arrays (columnar) — memory-lean for positions. */
  parseTicksColumnar(props: string[], ticks?: number[]): Columns;
  /** Projectile trajectory rows (grenade_type, tick, X/Y/Z, thrower_steamid). */
  parseGrenades(): Row[];
}

/** Iterate a columnar result as row objects without materializing them all. */
export function* iterColumns(cols: Columns): Generator<Row> {
  const keys = Object.keys(cols);
  if (keys.length === 0) return;
  const n = cols[keys[0]]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const row: Row = {};
    for (const k of keys) row[k] = cols[k][i];
    yield row;
  }
}
