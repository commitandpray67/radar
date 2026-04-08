"""
Coordinate transformation: CS2 game-world (X, Y, Z) → radar image (px, py).

The radar image is a top-down overview where:
  - game X increases to the right
  - game Y increases upward (but radar image Y increases downward)

Transformation formula (single-level):
  px = (world_x - pos_x) / scale
  py = (pos_y - world_y) / scale   ← note the inversion

For rotated radars the result is rotated around the image centre.

This module is the single source of truth for all coordinate math.
All callers (parser pipeline, heatmap generator, frontend via API) must
go through these functions so that calibration changes propagate everywhere.
"""

import math
from typing import Optional
import numpy as np

from maps.calibration import MapCalibration, RadarLayer, get_calibration


# Standard radar image dimensions (Valve exports 1024×1024 overview images)
RADAR_IMAGE_SIZE = 1024


def world_to_radar(
    world_x: float,
    world_y: float,
    world_z: float,
    calibration: MapCalibration,
    image_size: int = RADAR_IMAGE_SIZE,
) -> tuple[float, float, Optional[RadarLayer]]:
    """
    Convert a single world-coordinate point to radar pixel coordinates.

    Returns:
        (px, py, layer)
        layer is None for single-level maps, or the matching RadarLayer for
        multi-level maps (so the caller knows which image to draw on).

    Pixel coordinates are in [0, image_size] space.
    Points outside the radar extent will have px/py outside [0, image_size].
    """
    # Raw pixel coordinates before rotation
    px = (world_x - calibration.pos_x) / calibration.scale
    # Y is inverted: game Y up, image Y down
    py = (calibration.pos_y - world_y) / calibration.scale

    # Apply rotation around image centre
    if calibration.rotate != 0:
        cx = cy = image_size / 2.0
        angle_rad = -calibration.rotate * math.pi / 2.0  # CCW in image space
        cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
        dx, dy = px - cx, py - cy
        px = cos_a * dx - sin_a * dy + cx
        py = sin_a * dx + cos_a * dy + cy

    layer: Optional[RadarLayer] = None
    if calibration.is_multilevel:
        layer = calibration.layer_for_z(world_z)

    return px, py, layer


def world_to_radar_batch(
    coords: np.ndarray,  # shape (N, 3): columns [world_x, world_y, world_z]
    calibration: MapCalibration,
    image_size: int = RADAR_IMAGE_SIZE,
) -> np.ndarray:
    """
    Vectorised version of world_to_radar for large position arrays.

    Returns:
        np.ndarray of shape (N, 2): columns [px, py]
        (layer logic is intentionally omitted here; use per-row world_to_radar
        or filter by Z before calling this function)
    """
    px = (coords[:, 0] - calibration.pos_x) / calibration.scale
    py = (calibration.pos_y - coords[:, 1]) / calibration.scale

    if calibration.rotate != 0:
        cx = cy = image_size / 2.0
        angle_rad = -calibration.rotate * math.pi / 2.0
        cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
        dx, dy = px - cx, py - cy
        rot_px = cos_a * dx - sin_a * dy + cx
        rot_py = sin_a * dx + cos_a * dy + cy
        px, py = rot_px, rot_py

    return np.column_stack([px, py])


def radar_to_world(
    px: float,
    py: float,
    calibration: MapCalibration,
    image_size: int = RADAR_IMAGE_SIZE,
) -> tuple[float, float]:
    """
    Inverse transform: radar pixel → world (X, Y).
    Useful for converting click positions on the frontend back to game coords.
    """
    # Undo rotation
    if calibration.rotate != 0:
        cx = cy = image_size / 2.0
        angle_rad = calibration.rotate * math.pi / 2.0  # opposite direction
        cos_a, sin_a = math.cos(angle_rad), math.sin(angle_rad)
        dx, dy = px - cx, py - cy
        px = cos_a * dx - sin_a * dy + cx
        py = sin_a * dx + cos_a * dy + cy

    world_x = px * calibration.scale + calibration.pos_x
    world_y = calibration.pos_y - py * calibration.scale
    return world_x, world_y


def clamp_to_radar(
    px: float, py: float, image_size: int = RADAR_IMAGE_SIZE
) -> tuple[float, float]:
    """Clamp pixel coordinates to valid radar image bounds."""
    return (
        max(0.0, min(float(image_size), px)),
        max(0.0, min(float(image_size), py)),
    )


def get_calibration_or_raise(map_name: str) -> MapCalibration:
    """Fetch calibration or raise ValueError with a helpful message."""
    cal = get_calibration(map_name)
    if cal is None:
        from maps.calibration import MAP_CALIBRATIONS
        known = ", ".join(sorted(MAP_CALIBRATIONS.keys()))
        raise ValueError(
            f"No radar calibration found for map '{map_name}'. "
            f"Known maps: {known}"
        )
    return cal
