"""
Map calibration data for CS2 radar coordinate transformation.

Each entry maps game-world (X, Y, Z) coordinates to radar image pixel coordinates.
Values sourced from CS2 game files (resource/overviews/<map>.txt / _radar_spectate).

Schema for each map:
  pos_x, pos_y : top-left corner of the radar image in game-world units
  scale        : game units per radar pixel
  rotate       : rotation applied to radar (0 = standard, 1 = 90° CW, 2 = 180°, 3 = 90° CCW)
  zoom         : unused by us; kept for reference parity with Valve overview files
  layers       : list of altitude thresholds for multi-level maps (Nuke, Vertigo)
                 Each layer has a 'z_min', 'z_max', and 'image' filename.

To add a new map: add an entry to MAP_CALIBRATIONS using the map name as it
appears in the parsed demo (e.g. "de_dust2").

The full set of official values can be extracted from CS2 game files at:
  game/csgo/resource/overviews/<mapname>.txt
"""

from dataclasses import dataclass, field


@dataclass
class RadarLayer:
    """A single altitude slice of a multi-level map."""

    image: str  # filename under frontend/public/maps/
    z_min: float  # minimum world Z for this layer (inclusive)
    z_max: float  # maximum world Z for this layer (exclusive); use +inf for top layer
    label: str = ""  # human label e.g. "Upper", "Lower"


@dataclass
class MapCalibration:
    """Coordinate transformation parameters for one CS2 map."""

    # Top-left corner of the radar image in game-world coordinates
    pos_x: float
    pos_y: float
    # Game world units per pixel in the radar image
    scale: float
    # Radar image rotation: 0 = none, 1 = 90 CW, 2 = 180, 3 = 90 CCW
    rotate: int = 0
    # For single-level maps: the radar image filename
    image: str = ""
    # For multi-level maps: ordered list of layers (bottom → top)
    layers: list[RadarLayer] = field(default_factory=list)
    # Approximate world-coordinate centres of bombsites A and B. Used to label
    # bomb_planted events by computing which centre the planter is closer to;
    # leave as None if unknown (events fall back to the parser's site index).
    bombsite_a: tuple[float, float] | None = None
    bombsite_b: tuple[float, float] | None = None

    @property
    def is_multilevel(self) -> bool:
        return len(self.layers) > 0

    def layer_for_z(self, z: float) -> RadarLayer | None:
        """Return the layer that contains the given world Z coordinate."""
        for layer in self.layers:
            if layer.z_min <= z < layer.z_max:
                return layer
        # Fall back to topmost layer if Z exceeds all thresholds
        return self.layers[-1] if self.layers else None


# ---------------------------------------------------------------------------
# Official Valve calibration values
# These are taken from game/csgo/resource/overviews/*.txt and cross-verified
# with community tools (cs2-heatmap, awpy).
# Values marked [ESTIMATED] need verification against actual game files.
# ---------------------------------------------------------------------------

MAP_CALIBRATIONS: dict[str, MapCalibration] = {
    "de_dust2": MapCalibration(
        pos_x=-2476.0,
        pos_y=3239.0,
        scale=4.4,
        image="de_dust2.png",
        bombsite_a=(1240.0, 2540.0),
        bombsite_b=(-1547.0, 2685.0),
    ),
    "de_mirage": MapCalibration(
        pos_x=-3230.0,
        pos_y=1713.0,
        scale=5.0,
        image="de_mirage.png",
        bombsite_a=(1175.0, -19.0),
        bombsite_b=(-1841.0, -1847.0),
    ),
    "de_inferno": MapCalibration(
        pos_x=-2087.0,
        pos_y=3870.0,
        scale=4.9,
        image="de_inferno.png",
        bombsite_a=(1936.0, 421.0),
        bombsite_b=(170.0, 2790.0),
    ),
    "de_cache": MapCalibration(
        pos_x=-2000.0,
        pos_y=3250.0,
        scale=5.5,
        image="de_cache.png",
    ),
    "de_overpass": MapCalibration(
        pos_x=-4831.0,
        pos_y=1781.0,
        scale=5.2,
        image="de_overpass.png",
        bombsite_a=(-3270.0, 100.0),
        bombsite_b=(-2068.0, 1015.0),
    ),
    "de_ancient": MapCalibration(
        pos_x=-2953.0,
        pos_y=2164.0,
        scale=5.0,
        image="de_ancient.png",
        bombsite_a=(-470.0, -1340.0),
        bombsite_b=(-1740.0, 320.0),
    ),
    "de_anubis": MapCalibration(
        pos_x=-2796.0,
        pos_y=3328.0,
        scale=5.22,
        image="de_anubis.png",
        bombsite_a=(1200.0, 800.0),
        bombsite_b=(-650.0, -500.0),
    ),
    "de_vertigo": MapCalibration(
        pos_x=-3168.0,
        pos_y=1762.0,
        scale=4.0,
        layers=[
            RadarLayer(
                image="de_vertigo.png",
                z_min=-float("inf"),
                z_max=11700.0,
                label="Lower",
            ),
            RadarLayer(
                image="de_vertigo.png",
                z_min=11700.0,
                z_max=float("inf"),
                label="Upper",
            ),
        ],
        bombsite_a=(-680.0, -540.0),
        bombsite_b=(-1990.0, 1490.0),
    ),
    "de_nuke": MapCalibration(
        pos_x=-3453.0,
        pos_y=2887.0,
        scale=7.0,
        layers=[
            RadarLayer(
                image="de_nuke.png",
                z_min=-float("inf"),
                z_max=-495.0,
                label="Lower",
            ),
            RadarLayer(
                image="de_nuke.png",
                z_min=-495.0,
                z_max=float("inf"),
                label="Upper",
            ),
        ],
        # Nuke A/B are stacked vertically; we use rough X/Y centres knowing the
        # nearest-neighbour check is robust as long as A and B don't collide.
        bombsite_a=(-700.0, -920.0),
        bombsite_b=(-700.0, -700.0),
    ),
    # [ESTIMATED] — update once Valve overview file is verified
    "de_train": MapCalibration(
        pos_x=-2477.0,
        pos_y=2392.0,
        scale=4.7,
        image="de_train.png",
        bombsite_a=(-475.0, -445.0),
        bombsite_b=(-1640.0, 405.0),
    ),
    "de_office": MapCalibration(
        pos_x=-1838.0,
        pos_y=1858.0,
        scale=4.1,
        image="de_office.png",
    ),
    "cs_italy": MapCalibration(
        pos_x=-2647.0,
        pos_y=2592.0,
        scale=4.6,
        image="cs_italy.png",
    ),
}


def get_calibration(map_name: str) -> MapCalibration | None:
    """
    Look up calibration by map name.
    Handles 'workshop/' prefixes and unknown suffixes gracefully.
    """
    # Exact match first
    if map_name in MAP_CALIBRATIONS:
        return MAP_CALIBRATIONS[map_name]

    # Strip workshop prefix
    if "/" in map_name:
        map_name = map_name.split("/")[-1]
        if map_name in MAP_CALIBRATIONS:
            return MAP_CALIBRATIONS[map_name]

    # Prefix match (e.g. "de_dust2_ce" → "de_dust2")
    for key in MAP_CALIBRATIONS:
        if map_name.startswith(key):
            return MAP_CALIBRATIONS[key]

    return None
