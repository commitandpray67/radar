/**
 * Client-side coordinate utilities.
 *
 * For the radar viewer we need to convert game-world (X, Y) to canvas pixel
 * positions on top of the radar image, then scale those pixels to fit the
 * current canvas element size.
 *
 * The actual calibration values come from the server (/api/maps), so this
 * module only handles the math — not the data.
 */

import type { MapMeta, RadarLayerMeta } from '../types';

export const RADAR_IMAGE_SIZE = 1024; // Valve standard radar image size in pixels

export interface CalibrationParams {
  pos_x: number;
  pos_y: number;
  scale: number;
  rotate: number; // 0 | 1 | 2 | 3
}

/**
 * Convert world coordinates to radar pixel coordinates [0, RADAR_IMAGE_SIZE].
 * Mirrors the backend analytics/coordinates.py::world_to_radar function.
 */
export function worldToRadar(
  worldX: number,
  worldY: number,
  cal: CalibrationParams,
  imageSize = RADAR_IMAGE_SIZE,
): { px: number; py: number } {
  let px = (worldX - cal.pos_x) / cal.scale;
  let py = (cal.pos_y - worldY) / cal.scale; // Y-axis inversion

  if (cal.rotate !== 0) {
    const cx = imageSize / 2;
    const cy = imageSize / 2;
    const angleRad = -(cal.rotate * Math.PI) / 2;
    const cosA = Math.cos(angleRad);
    const sinA = Math.sin(angleRad);
    const dx = px - cx;
    const dy = py - cy;
    px = cosA * dx - sinA * dy + cx;
    py = sinA * dx + cosA * dy + cy;
  }

  return { px, py };
}

/**
 * Scale radar pixel coords [0, RADAR_IMAGE_SIZE] to canvas pixel coords.
 * canvasSize is the current rendered size of the canvas element.
 */
export function radarToCanvas(
  px: number,
  py: number,
  canvasSize: number,
  imageSize = RADAR_IMAGE_SIZE,
): { cx: number; cy: number } {
  const scale = canvasSize / imageSize;
  return { cx: px * scale, cy: py * scale };
}

/**
 * Full pipeline: world coordinates → canvas pixel coords.
 */
export function worldToCanvas(
  worldX: number,
  worldY: number,
  cal: CalibrationParams,
  canvasSize: number,
): { cx: number; cy: number } {
  const { px, py } = worldToRadar(worldX, worldY, cal);
  return radarToCanvas(px, py, canvasSize);
}

/**
 * Determine which radar layer to render for a given Z coordinate.
 * Returns the layer or undefined for single-level maps.
 */
export function getLayerForZ(
  worldZ: number,
  layers: RadarLayerMeta[],
): RadarLayerMeta | undefined {
  if (!layers.length) return undefined;
  for (const layer of layers) {
    if (worldZ >= layer.z_min && worldZ < layer.z_max) return layer;
  }
  return layers[layers.length - 1]; // fallback to topmost
}

/**
 * Build the public URL for a radar image.
 * Images live under /maps/ in the frontend's public/ directory.
 */
export function radarImageUrl(filename: string): string {
  return `/maps/${filename}`;
}

/**
 * Return the radar image URL for a player's current Z level.
 */
export function radarImageForPlayer(
  worldZ: number,
  map: MapMeta,
): string {
  if (!map.is_multilevel) return radarImageUrl(map.image);
  const layer = getLayerForZ(worldZ, map.layers);
  return layer ? radarImageUrl(layer.image) : radarImageUrl(map.image);
}
