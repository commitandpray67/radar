"""
Tests for map calibration data and lookup logic.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from maps.calibration import MAP_CALIBRATIONS, MapCalibration, get_calibration


class TestMapCalibrations:
    """Validate the calibration data dictionary."""

    def test_all_known_maps_present(self) -> None:
        expected = {
            "de_dust2",
            "de_mirage",
            "de_inferno",
            "de_cache",
            "de_overpass",
            "de_ancient",
            "de_anubis",
            "de_vertigo",
            "de_nuke",
            "de_train",
            "de_office",
            "cs_italy",
        }
        missing = expected - set(MAP_CALIBRATIONS.keys())
        assert not missing, f"Missing calibrations: {missing}"

    def test_all_calibrations_have_valid_scale(self) -> None:
        for name, cal in MAP_CALIBRATIONS.items():
            assert cal.scale > 0, f"{name}: scale must be positive, got {cal.scale}"

    def test_rotate_values_are_0_to_3(self) -> None:
        for name, cal in MAP_CALIBRATIONS.items():
            assert cal.rotate in (0, 1, 2, 3), f"{name}: rotate must be 0-3, got {cal.rotate}"

    def test_single_level_maps_have_image(self) -> None:
        for name, cal in MAP_CALIBRATIONS.items():
            if not cal.is_multilevel:
                assert cal.image, f"{name}: single-level map must have an image filename"

    def test_multilevel_maps_have_layers(self) -> None:
        for name, cal in MAP_CALIBRATIONS.items():
            if cal.is_multilevel:
                assert len(cal.layers) >= 2, f"{name}: multi-level map must have at least 2 layers"

    def test_nuke_is_multilevel(self) -> None:
        nuke = MAP_CALIBRATIONS["de_nuke"]
        assert nuke.is_multilevel
        labels = [la.label for la in nuke.layers]
        assert "Lower" in labels and "Upper" in labels

    def test_vertigo_is_multilevel(self) -> None:
        vtg = MAP_CALIBRATIONS["de_vertigo"]
        assert vtg.is_multilevel

    def test_dust2_not_multilevel(self) -> None:
        d2 = MAP_CALIBRATIONS["de_dust2"]
        assert not d2.is_multilevel


class TestGetCalibration:
    def test_exact_match(self) -> None:
        cal = get_calibration("de_dust2")
        assert cal is not None
        assert isinstance(cal, MapCalibration)

    def test_workshop_prefix_stripped(self) -> None:
        cal = get_calibration("workshop/de_dust2")
        assert cal is not None

    def test_suffix_match(self) -> None:
        # e.g. "de_dust2_ce" should match "de_dust2"
        cal = get_calibration("de_dust2_ce")
        assert cal is not None

    def test_unknown_map_returns_none(self) -> None:
        cal = get_calibration("de_unknown_map_xyz")
        assert cal is None

    def test_case_sensitive(self) -> None:
        # Map names in CS2 are lowercase; uppercase should not match
        cal = get_calibration("DE_DUST2")
        assert cal is None


class TestLayerForZ:
    def test_nuke_lower(self) -> None:
        nuke = MAP_CALIBRATIONS["de_nuke"]
        layer = nuke.layer_for_z(-600.0)
        assert layer is not None and layer.label == "Lower"

    def test_nuke_upper(self) -> None:
        nuke = MAP_CALIBRATIONS["de_nuke"]
        layer = nuke.layer_for_z(0.0)
        assert layer is not None and layer.label == "Upper"

    def test_vertigo_lower(self) -> None:
        vtg = MAP_CALIBRATIONS["de_vertigo"]
        layer = vtg.layer_for_z(10000.0)
        assert layer is not None and layer.label == "Lower"

    def test_vertigo_upper(self) -> None:
        vtg = MAP_CALIBRATIONS["de_vertigo"]
        layer = vtg.layer_for_z(12000.0)
        assert layer is not None and layer.label == "Upper"

    def test_single_level_returns_none(self) -> None:
        d2 = MAP_CALIBRATIONS["de_dust2"]
        assert d2.layer_for_z(0.0) is None
