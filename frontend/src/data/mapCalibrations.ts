/**
 * Map calibration data — client-side port of `backend/maps/calibration.py`.
 *
 * In the static/in-browser build there is no `/api/maps` endpoint, so this
 * table is the single source of truth for:
 *   - radar coordinate transforms (pos_x/pos_y/scale/rotate + layers),
 *   - bombsite A/B centres used by the parser to label bomb_planted events.
 *
 * Values are the official Valve overview numbers, kept byte-for-byte in sync
 * with the Python table. `RADAR_IMAGE_SIZE` lives in `utils/coordinates.ts`.
 */

import type { MapMeta, RadarLayerMeta } from '../types';

export interface MapCalibration {
  /** Top-left corner of the radar image in game-world coordinates. */
  pos_x: number;
  pos_y: number;
  /** Game-world units per radar pixel. */
  scale: number;
  /** Radar rotation: 0 = none, 1 = 90° CW, 2 = 180°, 3 = 90° CCW. */
  rotate: number;
  /** Single-level radar image filename (under /maps/). */
  image: string;
  /** Multi-level maps: ordered layers (bottom → top). Empty for single-level. */
  layers: RadarLayerMeta[];
  /** Approx world-coordinate centres of bombsites A/B (for plant labelling). */
  bombsite_a: readonly [number, number] | null;
  bombsite_b: readonly [number, number] | null;
}

const NEG_INF = -Infinity;
const POS_INF = Infinity;

function cal(partial: Partial<MapCalibration> & Pick<MapCalibration, 'pos_x' | 'pos_y' | 'scale'>): MapCalibration {
  return {
    rotate: 0,
    image: '',
    layers: [],
    bombsite_a: null,
    bombsite_b: null,
    ...partial,
  };
}

export const MAP_CALIBRATIONS: Record<string, MapCalibration> = {
  de_dust2: cal({
    pos_x: -2476, pos_y: 3239, scale: 4.4, image: 'de_dust2.png',
    bombsite_a: [1240, 2540], bombsite_b: [-1547, 2685],
  }),
  de_mirage: cal({
    pos_x: -3230, pos_y: 1713, scale: 5.0, image: 'de_mirage.png',
    bombsite_a: [1175, -19], bombsite_b: [-1841, -1847],
  }),
  de_inferno: cal({
    pos_x: -2087, pos_y: 3870, scale: 4.9, image: 'de_inferno.png',
    bombsite_a: [1936, 421], bombsite_b: [170, 2790],
  }),
  de_cache: cal({
    pos_x: -2000, pos_y: 3250, scale: 5.5, image: 'de_cache.png',
  }),
  de_overpass: cal({
    pos_x: -4831, pos_y: 1781, scale: 5.2, image: 'de_overpass.png',
    bombsite_a: [-3270, 100], bombsite_b: [-2068, 1015],
  }),
  de_ancient: cal({
    pos_x: -2953, pos_y: 2164, scale: 5.0, image: 'de_ancient.png',
    bombsite_a: [-1740, 320], bombsite_b: [-470, -1340],
  }),
  de_anubis: cal({
    pos_x: -2796, pos_y: 3328, scale: 5.22, image: 'de_anubis.png',
    bombsite_a: [1200, 800], bombsite_b: [-650, -500],
  }),
  de_vertigo: cal({
    pos_x: -3168, pos_y: 1762, scale: 4.0,
    layers: [
      { image: 'de_vertigo.png', z_min: NEG_INF, z_max: 11700, label: 'Lower' },
      { image: 'de_vertigo.png', z_min: 11700, z_max: POS_INF, label: 'Upper' },
    ],
    bombsite_a: [-680, -540], bombsite_b: [-1990, 1490],
  }),
  de_nuke: cal({
    pos_x: -3453, pos_y: 2887, scale: 7.0,
    layers: [
      { image: 'de_nuke.png', z_min: NEG_INF, z_max: -495, label: 'Lower' },
      { image: 'de_nuke.png', z_min: -495, z_max: POS_INF, label: 'Upper' },
    ],
    bombsite_a: [-700, -920], bombsite_b: [-700, -700],
  }),
  de_train: cal({
    pos_x: -2477, pos_y: 2392, scale: 4.7, image: 'de_train.png',
    bombsite_a: [-475, -445], bombsite_b: [-1640, 405],
  }),
  de_office: cal({
    pos_x: -1838, pos_y: 1858, scale: 4.1, image: 'de_office.png',
  }),
  cs_italy: cal({
    pos_x: -2647, pos_y: 2592, scale: 4.6, image: 'cs_italy.png',
  }),
};

/**
 * Look up calibration by map name — handles `workshop/` prefixes and unknown
 * suffixes (e.g. `de_dust2_ce` → `de_dust2`). Mirrors `get_calibration()`.
 */
export function getCalibration(mapName: string): MapCalibration | null {
  if (mapName in MAP_CALIBRATIONS) return MAP_CALIBRATIONS[mapName];

  let name = mapName;
  if (name.includes('/')) {
    name = name.split('/').pop() as string;
    if (name in MAP_CALIBRATIONS) return MAP_CALIBRATIONS[name];
  }
  for (const key of Object.keys(MAP_CALIBRATIONS)) {
    if (name.startsWith(key)) return MAP_CALIBRATIONS[key];
  }
  return null;
}

/** Serialize the table to the `MapMeta[]` shape the app expects from `/maps`. */
export function mapMetaList(): MapMeta[] {
  return Object.entries(MAP_CALIBRATIONS).map(([name, c]) => ({
    name,
    is_multilevel: c.layers.length > 0,
    image: c.image || (c.layers[0]?.image ?? ''),
    layers: c.layers,
  }));
}
