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
