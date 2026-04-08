"""
Tests for coordinate transformation logic.

These tests do NOT require a real demo file or demoparser2.
They validate the math used to convert game world coordinates to radar
pixel coordinates and back.
"""

import math
import pytest
import numpy as np

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from maps.calibration import MapCalibration, RadarLayer, get_calibration
from analytics.coordinates import (
    world_to_radar,
    world_to_radar_batch,
    radar_to_world,
    clamp_to_radar,
    RADAR_IMAGE_SIZE,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def dust2_cal() -> MapCalibration:
    """Return de_dust2 calibration as defined in calibration.py."""
    cal = get_calibration("de_dust2")
    assert cal is not None, "de_dust2 must be in MAP_CALIBRATIONS"
    return cal


@pytest.fixture()
def nuke_cal() -> MapCalibration:
    cal = get_calibration("de_nuke")
    assert cal is not None
    return cal


@pytest.fixture()
def simple_cal() -> MapCalibration:
    """A hand-crafted calibration for predictable maths."""
    return MapCalibration(
        pos_x=0.0,
        pos_y=1024.0,
        scale=1.0,
        rotate=0,
        image="test_radar.png",
    )


# ---------------------------------------------------------------------------
# Single-point world_to_radar
# ---------------------------------------------------------------------------

class TestWorldToRadar:
    def test_top_left_corner(self, simple_cal: MapCalibration) -> None:
        """World (0, 1024) should map to radar pixel (0, 0) — top-left."""
        px, py, layer = world_to_radar(0.0, 1024.0, 0.0, simple_cal)
        assert abs(px - 0.0) < 1e-6
        assert abs(py - 0.0) < 1e-6
        assert layer is None  # single-level map

    def test_bottom_right_corner(self, simple_cal: MapCalibration) -> None:
        """World (1024, 0) → radar pixel (1024, 1024) — bottom-right."""
        px, py, _ = world_to_radar(1024.0, 0.0, 0.0, simple_cal)
        assert abs(px - 1024.0) < 1e-6
        assert abs(py - 1024.0) < 1e-6

    def test_centre(self, simple_cal: MapCalibration) -> None:
        """World (512, 512) → radar pixel (512, 512) — centre."""
        px, py, _ = world_to_radar(512.0, 512.0, 0.0, simple_cal)
        assert abs(px - 512.0) < 1e-6
        assert abs(py - 512.0) < 1e-6

    def test_y_axis_inverted(self, simple_cal: MapCalibration) -> None:
        """Increasing game Y should decrease radar py (top-down view)."""
        _, py1, _ = world_to_radar(0.0, 200.0, 0.0, simple_cal)
        _, py2, _ = world_to_radar(0.0, 100.0, 0.0, simple_cal)
        assert py1 < py2, "Higher game Y should map to lower radar py"

    def test_dust2_calibration_range(self, dust2_cal: MapCalibration) -> None:
        """
        Typical Dust2 world coords should produce radar pixels in [0, 1024].
        Mid-bombsite A area is approximately (1200, 250) in world coords.
        """
        px, py, _ = world_to_radar(1200.0, 250.0, 0.0, dust2_cal)
        assert 0 <= px <= RADAR_IMAGE_SIZE, f"px={px} out of range"
        assert 0 <= py <= RADAR_IMAGE_SIZE, f"py={py} out of range"

    def test_rotate_0_identity(self, simple_cal: MapCalibration) -> None:
        """rotate=0 should produce the same result as the non-rotated formula."""
        simple_cal.rotate = 0
        px, py, _ = world_to_radar(100.0, 900.0, 0.0, simple_cal)
        assert abs(px - 100.0) < 1e-6
        assert abs(py - 124.0) < 1e-6  # (1024-900)/1.0 = 124

    def test_rotate_180(self, simple_cal: MapCalibration) -> None:
        """rotate=2 (180°) should produce mirror image."""
        simple_cal.rotate = 0
        px0, py0, _ = world_to_radar(100.0, 900.0, 0.0, simple_cal)
        simple_cal.rotate = 2
        px2, py2, _ = world_to_radar(100.0, 900.0, 0.0, simple_cal)
        # After 180° rotation around centre, both px and py should be mirrored
        assert abs(px2 - (RADAR_IMAGE_SIZE - px0)) < 1e-4
        assert abs(py2 - (RADAR_IMAGE_SIZE - py0)) < 1e-4


# ---------------------------------------------------------------------------
# Batch transformation
# ---------------------------------------------------------------------------

class TestWorldToRadarBatch:
    def test_batch_matches_single(self, dust2_cal: MapCalibration) -> None:
        """Batch results must match individual world_to_radar calls."""
        world_points = np.array([
            [1200.0, 250.0, 0.0],
            [-1000.0, 1000.0, 0.0],
            [500.0, -300.0, 0.0],
        ])
        batch_result = world_to_radar_batch(world_points, dust2_cal)

        for i, (wx, wy, wz) in enumerate(world_points):
            px, py, _ = world_to_radar(wx, wy, wz, dust2_cal)
            assert abs(batch_result[i, 0] - px) < 1e-6, f"px mismatch at row {i}"
            assert abs(batch_result[i, 1] - py) < 1e-6, f"py mismatch at row {i}"

    def test_batch_shape(self, dust2_cal: MapCalibration) -> None:
        n = 500
        coords = np.random.uniform(-3000, 3000, (n, 3))
        result = world_to_radar_batch(coords, dust2_cal)
        assert result.shape == (n, 2)


# ---------------------------------------------------------------------------
# Inverse transform
# ---------------------------------------------------------------------------

class TestRadarToWorld:
    def test_roundtrip(self, dust2_cal: MapCalibration) -> None:
        """world → radar → world should recover the original coordinates."""
        test_cases = [
            (0.0, 500.0, 0.0),
            (1200.0, 250.0, 0.0),
            (-500.0, -100.0, 0.0),
        ]
        for wx_in, wy_in, wz_in in test_cases:
            px, py, _ = world_to_radar(wx_in, wy_in, wz_in, dust2_cal)
            wx_out, wy_out = radar_to_world(px, py, dust2_cal)
            assert abs(wx_out - wx_in) < 1e-3, f"X roundtrip failed: {wx_in} → {wx_out}"
            assert abs(wy_out - wy_in) < 1e-3, f"Y roundtrip failed: {wy_in} → {wy_out}"


# ---------------------------------------------------------------------------
# Clamp
# ---------------------------------------------------------------------------

class TestClamp:
    def test_clamp_within_bounds(self) -> None:
        px, py = clamp_to_radar(512.0, 512.0)
        assert px == 512.0 and py == 512.0

    def test_clamp_negative(self) -> None:
        px, py = clamp_to_radar(-100.0, -50.0)
        assert px == 0.0 and py == 0.0

    def test_clamp_overflow(self) -> None:
        px, py = clamp_to_radar(2000.0, 1500.0)
        assert px == RADAR_IMAGE_SIZE and py == RADAR_IMAGE_SIZE


# ---------------------------------------------------------------------------
# Multi-level map layer selection
# ---------------------------------------------------------------------------

class TestMultiLevelMaps:
    def test_nuke_lower_layer(self, nuke_cal: MapCalibration) -> None:
        """Z below -495 should resolve to the lower layer."""
        _, _, layer = world_to_radar(0.0, 0.0, -600.0, nuke_cal)
        assert layer is not None
        assert layer.label == "Lower"

    def test_nuke_upper_layer(self, nuke_cal: MapCalibration) -> None:
        """Z above -495 should resolve to the upper layer."""
        _, _, layer = world_to_radar(0.0, 0.0, 0.0, nuke_cal)
        assert layer is not None
        assert layer.label == "Upper"

    def test_calibration_is_multilevel(self, nuke_cal: MapCalibration) -> None:
        assert nuke_cal.is_multilevel is True

    def test_dust2_not_multilevel(self, dust2_cal: MapCalibration) -> None:
        assert dust2_cal.is_multilevel is False
