import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from parser._events import _extract_player_state_events, _inventory_item_to_token
from parser._grenades import _extract_grenades
from parser.demo_parser import RoundInfo, _extract_positions


class DummyParser:
    def parse_ticks(self, _fields, ticks):
        return [
            {
                "tick": ticks[0],
                "steamid": 76561198000000000,
                "X": 100.0,
                "Y": 200.0,
                "Z": 10.0,
                "team_num": math.nan,
                "is_alive": True,
            }
        ]


def test_extract_positions_handles_nan_team_num() -> None:
    rounds = [
        RoundInfo(
            round_number=1,
            start_tick=100,
            end_tick=100,
            freeze_end_tick=100,
            winner_team="",
            win_reason="",
            ct_score=0,
            t_score=0,
        )
    ]

    progress_calls: list[tuple[float, str]] = []
    positions = _extract_positions(
        parser=DummyParser(),
        rounds=rounds,
        sample_rate=1,
        progress_cb=lambda frac, msg: progress_calls.append((frac, msg)),
    )

    assert len(positions) == 1
    assert positions[0].team_num == 0
    assert positions[0].player_id == 76561198000000000


# ---------------------------------------------------------------------------
# Inventory-prop weapon extraction
# ---------------------------------------------------------------------------


def test_inventory_item_to_token_maps_display_names() -> None:
    # Display names (any spacing/hyphenation) map to bare weapon tokens.
    assert _inventory_item_to_token("AK-47") == "ak47"
    assert _inventory_item_to_token("M4A1-S") == "m4a1_silencer"
    assert _inventory_item_to_token("M4A4") == "m4a1"
    assert _inventory_item_to_token("USP-S") == "usp_silencer"
    assert _inventory_item_to_token("High Explosive Grenade") == "hegrenade"
    assert _inventory_item_to_token("Smoke Grenade") == "smokegrenade"
    # Classnames pass through untouched; unknowns / armor / knives are skipped.
    assert _inventory_item_to_token("weapon_ak47") == "weapon_ak47"
    assert _inventory_item_to_token("Kevlar + Helmet") is None
    assert _inventory_item_to_token("Knife") is None
    assert _inventory_item_to_token("") is None
    assert _inventory_item_to_token(None) is None


class InventoryDummyParser:
    """Simulates a demo with NO item_* events, only the inventory prop —
    exactly the failure mode where loadouts render blank."""

    def parse_event(self, _name, other=None, player=None):
        raise RuntimeError("no item events in this demo")

    def parse_ticks(self, fields, ticks=None):
        if "inventory" in fields:
            return [
                {
                    "tick": 100,
                    "steamid": 111,
                    # Duplicate AK-47 must collapse to a single equip event.
                    "inventory": ["AK-47", "AK-47", "Glock-18", "Smoke Grenade", "Knife"],
                },
                {
                    "tick": 100,
                    "steamid": 222,
                    "inventory": ["AWP", "USP-S", "High Explosive Grenade", "Kevlar + Helmet"],
                },
            ]
        return []  # freeze-end HP/armor fallback: nothing


def test_inventory_sampling_produces_equip_events() -> None:
    rounds = [
        RoundInfo(
            round_number=1,
            start_tick=0,
            end_tick=200,
            freeze_end_tick=100,
            winner_team="",
            win_reason="",
            ct_score=0,
            t_score=0,
        )
    ]

    events = _extract_player_state_events(InventoryDummyParser(), rounds, tick_rate=64.0)
    equips = [e for e in events if e.event_type == "equip"]
    by_player: dict[int, set[str]] = {}
    for e in equips:
        by_player.setdefault(e.player_id, set()).add(e.weapon or "")

    # Player 111: ak47 + glock + smoke (Knife skipped, AK deduped).
    assert by_player[111] == {"ak47", "glock", "smokegrenade"}
    # Player 222: awp + usp + he (Kevlar+Helmet not a loadout token).
    assert by_player[222] == {"awp", "usp_silencer", "hegrenade"}
    # Dedup: exactly one AK-47 equip despite two inventory entries.
    assert sum(1 for e in equips if e.player_id == 111 and e.weapon == "ak47") == 1


# ---------------------------------------------------------------------------
# Grenade trajectory fallback (no weapon_fire events)
# ---------------------------------------------------------------------------


class GrenadeDummyParser:
    """Simulates a demo with NO weapon_fire / detonation events, but WITH
    parse_grenades() projectile trajectories — the case where utility
    stopped rendering because grenades are built only from throw events."""

    def parse_event(self, _name, other=None, player=None):
        raise RuntimeError("no weapon_fire / detonation events in this demo")

    def parse_grenades(self):
        # A single smoke flying from (0,0) to (500,300) over ticks 100..112.
        rows = []
        for i in range(7):
            rows.append(
                {
                    "tick": 100 + i * 2,
                    "grenade_type": "smoke",
                    "X": float(i * 80),
                    "Y": float(i * 50),
                    "Z": 64.0,
                    "thrower_steamid": 111.0,
                }
            )
        return rows


def test_grenade_fallback_synthesizes_from_trajectories() -> None:
    rounds = [
        RoundInfo(
            round_number=1,
            start_tick=0,
            end_tick=5000,
            freeze_end_tick=100,
            winner_team="",
            win_reason="",
            ct_score=0,
            t_score=0,
        )
    ]

    grenades = _extract_grenades(GrenadeDummyParser(), rounds, tick_rate=64.0)

    # Exactly one smoke synthesized from the trajectory, with a landing point
    # and a real flight path, despite there being no throw/detonation events.
    assert len(grenades) == 1
    g = grenades[0]
    assert g.grenade_type == "smoke"
    assert g.throw_tick == 100
    assert g.detonate_tick == 112
    assert g.thrower_id == 111
    assert g.trajectory and len(g.trajectory) >= 2
    # Landing position matches the last tracked point.
    assert g.x == 480.0 and g.y == 300.0
    # Smoke effect duration (~18 s = 1152 ticks at 64 tick) added past landing.
    assert g.expire_tick == 112 + 1152


# ---------------------------------------------------------------------------
# _build_tracks — the grenade-trajectory tracker (webbing regression tests)
# ---------------------------------------------------------------------------

from parser._grenades import _build_tracks  # noqa: E402


def _row(tick, x, y, thrower=0):
    return {"tick": tick, "x": float(x), "y": float(y), "z": 0.0, "thrower_id": thrower}


def _is_smooth(track, max_step=60.0):
    """No segment longer than max_step units — a webbed track has huge jumps."""
    for a, b in zip(track, track[1:], strict=False):
        if math.hypot(b["x"] - a["x"], b["y"] - a["y"]) > max_step:
            return False
    return True


def test_tracks_resting_and_flying_grenades_stay_separate() -> None:
    """The webbing bug: a smoke resting at (0,0) emits every tick while a second
    smoke flies past within the match radius. The old tracker merged them into
    one alternating rest/flight track (rendered as a fan of lines)."""
    rows = []
    for i in range(30):
        tick = 1000 + i * 2
        rows.append(_row(tick, 0, 0))                 # resting smoke
        rows.append(_row(tick, 100 + i * 15, 50))     # flying smoke, passes nearby
    rows.sort(key=lambda r: r["tick"])

    tracks = _build_tracks(rows)
    assert len(tracks) == 2
    for track in tracks:
        assert _is_smooth(track), "track alternates between two projectiles (webbing)"
    # One track is the stationary smoke, the other strictly advances in x.
    by_len_x = sorted(tracks, key=lambda t: t[-1]["x"] - t[0]["x"])
    assert by_len_x[0][0]["x"] == 0 and by_len_x[0][-1]["x"] == 0
    assert by_len_x[1][-1]["x"] > by_len_x[1][0]["x"]


def test_tracks_same_tick_duplicates_collapse_to_one() -> None:
    """parse_grenades() can emit duplicate rows per tick for one projectile."""
    rows = []
    for i in range(10):
        tick = 500 + i
        rows.append(_row(tick, i * 10, 0))
        rows.append(_row(tick, i * 10 + 0.5, 0))  # near-identical duplicate
    tracks = _build_tracks(rows)
    assert len(tracks) == 1
    assert len(tracks[0]) == 10  # duplicates collapsed, not forked


def test_tracks_known_throwers_never_mix() -> None:
    """Two grenades from different throwers crossing paths stay separate even
    when they come within the match radius of each other."""
    rows = []
    for i in range(20):
        tick = 100 + i
        rows.append(_row(tick, i * 20, 0, thrower=111))        # left → right
        rows.append(_row(tick, 380 - i * 20, 40, thrower=222))  # right → left
    rows.sort(key=lambda r: r["tick"])

    tracks = _build_tracks(rows)
    assert len(tracks) == 2
    for track in tracks:
        throwers = {p["thrower_id"] for p in track}
        assert len(throwers) == 1, "a track mixed two throwers"
        assert _is_smooth(track, max_step=45.0)


def test_tracks_single_grenade_unaffected() -> None:
    rows = [_row(100 + i, i * 12, i * 5) for i in range(40)]
    tracks = _build_tracks(rows)
    assert len(tracks) == 1
    assert len(tracks[0]) == 40
