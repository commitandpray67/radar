"""
Heatmap generation from player position data.

Pipeline:
  1. Filter positions by player IDs, round numbers, and optional time window
  2. Convert world coordinates to radar pixel coordinates (vectorised)
  3. Accumulate counts into a 2D grid (histogram)
  4. Smooth with a Gaussian kernel
  5. Normalise to [0, 1]
  6. Return as a flat array that the frontend renders as a Canvas ImageData

For multi-level maps the caller specifies which layer to generate the heatmap
for, and only positions within that layer's Z range are included.
"""

from __future__ import annotations

import io
import base64
import math
from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np
from scipy.ndimage import gaussian_filter

from analytics.coordinates import world_to_radar_batch, RADAR_IMAGE_SIZE
from maps.calibration import MapCalibration


@dataclass
class HeatmapRequest:
    """Input parameters for a heatmap computation."""
    player_ids: list[int]            # steam IDs or entity IDs from the parse
    round_numbers: list[int]         # e.g. [1, 3, 5]
    map_name: str
    layer_label: Optional[str] = None  # "Upper" / "Lower" for multi-level maps
    exclude_freeze_time: bool = True   # drop positions before round start
    team_filter: Optional[str] = None  # "CT" | "T" | None (both)
    # Sampling: use every Nth position row; lower = more detail, higher = faster
    sample_every: int = 1
    # Grid resolution (radar pixels per cell); lower = finer grid
    grid_cell_size: int = 4
    # Gaussian smoothing radius in grid cells
    blur_sigma: float = 3.0
    image_size: int = RADAR_IMAGE_SIZE


@dataclass
class HeatmapResult:
    """Output of a heatmap computation."""
    # 2D numpy array, shape (grid_h, grid_w), values in [0, 1]
    density: np.ndarray
    grid_w: int
    grid_h: int
    # The layer label this heatmap was computed for (or "" for single-level)
    layer_label: str
    # Total position samples used
    sample_count: int


def compute_heatmap(
    positions: np.ndarray,  # shape (N, 6+): [tick, round, player_id, x, y, z, ...]
    request: HeatmapRequest,
    calibration: MapCalibration,
) -> HeatmapResult:
    """
    Core heatmap computation.

    `positions` is a structured array / numpy array where columns are:
      0: tick
      1: round_number
      2: player_id
      3: world_x
      4: world_y
      5: world_z
      6: team  (optional, "CT"/"T" as integer 2/3 or string)

    Returns a HeatmapResult with a normalised density grid.
    """
    # ---- 1. Filter by round -----------------------------------------------
    round_mask = np.isin(positions[:, 1].astype(int), request.round_numbers)
    data = positions[round_mask]

    # ---- 2. Filter by player -----------------------------------------------
    player_mask = np.isin(data[:, 2].astype(int), request.player_ids)
    data = data[player_mask]

    # ---- 3. Optional team filter -------------------------------------------
    if request.team_filter is not None and data.shape[1] > 6:
        team_map = {"CT": 3, "T": 2}
        target_team = team_map.get(request.team_filter.upper())
        if target_team is not None:
            team_mask = data[:, 6].astype(int) == target_team
            data = data[team_mask]

    # ---- 4. Sample every Nth row ------------------------------------------
    if request.sample_every > 1:
        data = data[:: request.sample_every]

    if data.shape[0] == 0:
        grid_w = math.ceil(request.image_size / request.grid_cell_size)
        grid_h = math.ceil(request.image_size / request.grid_cell_size)
        return HeatmapResult(
            density=np.zeros((grid_h, grid_w)),
            grid_w=grid_w,
            grid_h=grid_h,
            layer_label=request.layer_label or "",
            sample_count=0,
        )

    world_xyz = data[:, 3:6].astype(np.float64)

    # ---- 5. Layer filter for multi-level maps ------------------------------
    if calibration.is_multilevel and request.layer_label:
        target_layer = next(
            (la for la in calibration.layers if la.label == request.layer_label),
            None,
        )
        if target_layer is not None:
            z_mask = (world_xyz[:, 2] >= target_layer.z_min) & (
                world_xyz[:, 2] < target_layer.z_max
            )
            world_xyz = world_xyz[z_mask]

    if world_xyz.shape[0] == 0:
        grid_w = math.ceil(request.image_size / request.grid_cell_size)
        grid_h = math.ceil(request.image_size / request.grid_cell_size)
        return HeatmapResult(
            density=np.zeros((grid_h, grid_w)),
            grid_w=grid_w,
            grid_h=grid_h,
            layer_label=request.layer_label or "",
            sample_count=0,
        )

    # ---- 6. Convert world → radar pixels -----------------------------------
    radar_px = world_to_radar_batch(world_xyz, calibration, request.image_size)

    # ---- 7. Build 2D histogram ---------------------------------------------
    grid_w = math.ceil(request.image_size / request.grid_cell_size)
    grid_h = math.ceil(request.image_size / request.grid_cell_size)

    # np.histogram2d: x axis = px (columns), y axis = py (rows)
    hist, _, _ = np.histogram2d(
        radar_px[:, 0],   # x pixels → columns
        radar_px[:, 1],   # y pixels → rows
        bins=[grid_w, grid_h],
        range=[[0, request.image_size], [0, request.image_size]],
    )

    # Transpose so shape is (rows=grid_h, cols=grid_w) matching image coords
    density_grid: np.ndarray = hist.T

    # ---- 8. Gaussian smoothing --------------------------------------------
    if request.blur_sigma > 0:
        density_grid = gaussian_filter(density_grid, sigma=request.blur_sigma)

    # ---- 9. Normalise to [0, 1] -------------------------------------------
    max_val = density_grid.max()
    if max_val > 0:
        density_grid = density_grid / max_val

    return HeatmapResult(
        density=density_grid,
        grid_w=grid_w,
        grid_h=grid_h,
        layer_label=request.layer_label or "",
        sample_count=int(world_xyz.shape[0]),
    )


def heatmap_to_rgba(
    result: HeatmapResult,
    colormap: str = "jet",
    alpha_scale: float = 0.75,
    image_size: int = RADAR_IMAGE_SIZE,
) -> np.ndarray:
    """
    Convert a HeatmapResult density grid to a full RGBA image array.

    Returns shape (image_size, image_size, 4) uint8 array suitable for
    encoding to PNG or passing to the frontend as raw bytes.

    colormap: "jet" (default, classic heatmap) or "inferno"
    alpha_scale: maximum alpha for the hottest cell (0-1)
    """
    import matplotlib.cm as cm  # only imported when rendering; lightweight dep

    cmap = cm.get_cmap(colormap)

    # Upscale density grid to full image_size using nearest-neighbour
    from PIL import Image as PILImage

    grid_img = PILImage.fromarray((result.density * 255).astype(np.uint8), mode="L")
    grid_img = grid_img.resize(
        (image_size, image_size), resample=PILImage.NEAREST
    )
    density_full = np.array(grid_img) / 255.0  # shape (H, W), [0, 1]

    # Apply colormap → shape (H, W, 4) with float [0, 1]
    rgba = cmap(density_full)  # type: ignore[attr-defined]

    # Replace alpha channel: proportional to density, scaled by alpha_scale
    rgba[:, :, 3] = density_full * alpha_scale

    # Convert to uint8
    return (rgba * 255).astype(np.uint8)


def heatmap_to_base64_png(
    result: HeatmapResult,
    image_size: int = RADAR_IMAGE_SIZE,
) -> str:
    """
    Render the heatmap as a base64-encoded PNG string.
    Returned string can be used directly as a data: URL on the frontend.
    """
    from PIL import Image as PILImage

    rgba_arr = heatmap_to_rgba(result, image_size=image_size)
    img = PILImage.fromarray(rgba_arr, mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return base64.b64encode(buf.getvalue()).decode("ascii")
