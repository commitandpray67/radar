"""
Tests for heatmap generation logic.

Uses synthetic position data so no real demo is needed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import math

import numpy as np
import pytest

from analytics.heatmap import HeatmapRequest, HeatmapResult, compute_heatmap
from maps.calibration import get_calibration

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def dust2_cal():
    cal = get_calibration("de_dust2")
    assert cal is not None
    return cal


def make_positions(
    player_id: int,
    round_number: int,
    world_x: float,
    world_y: float,
    world_z: float = 0.0,
    n: int = 50,
    team_num: int = 3,
) -> np.ndarray:
    """Create N identical positions for testing concentration."""
    rows = np.array(
        [[0, round_number, player_id, world_x, world_y, world_z, team_num]] * n,
        dtype=np.float64,
    )
    # Add a tiny jitter so they don't collapse to one bin
    rows[:, 3] += np.random.uniform(-10, 10, n)
    rows[:, 4] += np.random.uniform(-10, 10, n)
    return rows


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestComputeHeatmap:
    def test_returns_heatmap_result(self, dust2_cal) -> None:
        pos = make_positions(player_id=1, round_number=1, world_x=0, world_y=500)
        req = HeatmapRequest(
            player_ids=[1],
            round_numbers=[1],
            map_name="de_dust2",
            blur_sigma=2.0,
        )
        result = compute_heatmap(pos, req, dust2_cal)
        assert isinstance(result, HeatmapResult)

    def test_density_normalised_to_0_1(self, dust2_cal) -> None:
        pos = make_positions(player_id=1, round_number=1, world_x=0, world_y=500)
        req = HeatmapRequest(
            player_ids=[1],
            round_numbers=[1],
            map_name="de_dust2",
        )
        result = compute_heatmap(pos, req, dust2_cal)
        assert result.density.min() >= 0.0
        assert result.density.max() <= 1.0 + 1e-9  # allow floating point epsilon

    def test_empty_positions_returns_zero_grid(self, dust2_cal) -> None:
        pos = np.empty((0, 7), dtype=np.float64)
        req = HeatmapRequest(
            player_ids=[99],
            round_numbers=[1],
            map_name="de_dust2",
        )
        result = compute_heatmap(pos, req, dust2_cal)
        assert result.density.max() == 0.0
        assert result.sample_count == 0

    def test_player_filter_works(self, dust2_cal) -> None:
        """Positions for player 2 should be excluded when only player 1 requested."""
        pos1 = make_positions(player_id=1, round_number=1, world_x=0, world_y=500, n=100)
        pos2 = make_positions(player_id=2, round_number=1, world_x=1000, world_y=500, n=100)
        all_pos = np.vstack([pos1, pos2])

        req_p1 = HeatmapRequest(player_ids=[1], round_numbers=[1], map_name="de_dust2")
        req_p2 = HeatmapRequest(player_ids=[2], round_numbers=[1], map_name="de_dust2")

        result_p1 = compute_heatmap(all_pos, req_p1, dust2_cal)
        result_p2 = compute_heatmap(all_pos, req_p2, dust2_cal)

        # The two players are in different positions; their hotspot grids
        # should not be identical
        assert not np.allclose(result_p1.density, result_p2.density)

    def test_round_filter_works(self, dust2_cal) -> None:
        """Positions in round 2 should be excluded when only round 1 is requested."""
        pos_r1 = make_positions(player_id=1, round_number=1, world_x=0, world_y=500, n=50)
        pos_r2 = make_positions(player_id=1, round_number=2, world_x=1500, world_y=500, n=50)
        all_pos = np.vstack([pos_r1, pos_r2])

        req = HeatmapRequest(player_ids=[1], round_numbers=[1], map_name="de_dust2")
        result = compute_heatmap(all_pos, req, dust2_cal)

        # sample_count should only include round 1 rows
        assert result.sample_count == 50

    def test_sample_count_correct(self, dust2_cal) -> None:
        pos = make_positions(player_id=1, round_number=1, world_x=0, world_y=500, n=200)
        req = HeatmapRequest(
            player_ids=[1],
            round_numbers=[1],
            map_name="de_dust2",
            sample_every=1,
        )
        result = compute_heatmap(pos, req, dust2_cal)
        assert result.sample_count == 200

    def test_sample_every_reduces_count(self, dust2_cal) -> None:
        pos = make_positions(player_id=1, round_number=1, world_x=0, world_y=500, n=200)
        req = HeatmapRequest(
            player_ids=[1],
            round_numbers=[1],
            map_name="de_dust2",
            sample_every=2,
        )
        result = compute_heatmap(pos, req, dust2_cal)
        assert result.sample_count == 100

    def test_blur_sigma_zero_still_works(self, dust2_cal) -> None:
        pos = make_positions(player_id=1, round_number=1, world_x=0, world_y=500, n=30)
        req = HeatmapRequest(
            player_ids=[1],
            round_numbers=[1],
            map_name="de_dust2",
            blur_sigma=0.0,
        )
        result = compute_heatmap(pos, req, dust2_cal)
        assert result.density.max() <= 1.0 + 1e-9

    def test_grid_dimensions_are_correct(self, dust2_cal) -> None:
        pos = make_positions(player_id=1, round_number=1, world_x=0, world_y=500, n=30)
        cell = 8
        req = HeatmapRequest(
            player_ids=[1],
            round_numbers=[1],
            map_name="de_dust2",
            grid_cell_size=cell,
            image_size=1024,
        )
        result = compute_heatmap(pos, req, dust2_cal)
        expected = math.ceil(1024 / cell)
        assert result.grid_w == expected
        assert result.grid_h == expected
        assert result.density.shape == (expected, expected)
