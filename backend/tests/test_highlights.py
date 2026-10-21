"""Tests for multi-kill highlight detection and the /api/highlights route."""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from httpx import ASGITransport, AsyncClient

from analytics.highlights import candidate_rounds, find_highlights, normalize_weapon
from db.database import fetch_round_sides, get_connection, store_demo
from main import app

# Player 1 (CT) vs 10..14 (T); player 2 is P1's teammate.
SIDES = {rn: {1: "CT", 2: "CT", **{v: "T" for v in range(10, 15)}} for rn in (1, 2, 3)}
ROUNDS = [
    {"round_number": 0, "is_knife_round": True, "winner_team": ""},
    {"round_number": 1, "is_knife_round": False, "winner_team": "CT"},
    {"round_number": 2, "is_knife_round": False, "winner_team": "T"},
    {"round_number": 3, "is_knife_round": False, "winner_team": "CT"},
]
NAMES = {1: "Qiyarah", 2: "mate", **{v: f"t{v}" for v in range(10, 15)}}


def _death(tick, rn, atk, vic, weapon="deagle", hs=False):
    return {
        "tick": tick,
        "round_number": rn,
        "attacker_id": atk,
        "victim_id": vic,
        "weapon": weapon,
        "headshot": hs,
    }


def _find(deaths, **kw):
    return find_highlights(ROUNDS, deaths, SIDES, {1}, NAMES, 64.0, **kw)


def test_normalize_weapon():
    assert normalize_weapon("weapon_deagle") == "deagle"
    assert normalize_weapon("Deagle") == "deagle"
    assert normalize_weapon("desert_eagle") == "deagle"
    assert normalize_weapon("knife_karambit") == "knife"
    assert normalize_weapon("m4a1_silencer_off") == "m4a1_silencer"
    assert normalize_weapon("usp_silencer_off") == "usp_silencer"
    assert normalize_weapon(None) == ""


def test_weapon_filter_needs_only_some_kills_with_the_weapon():
    deaths = [
        # Round 1: 3 deagle kills
        _death(100, 1, 1, 10, hs=True),
        _death(164, 1, 1, 11),
        _death(228, 1, 1, 12),
        # Round 2: 2 deagle + 1 AK → still a deagle 3K by default
        _death(100, 2, 1, 10),
        _death(150, 2, 1, 11, weapon="ak47"),
        _death(200, 2, 1, 12),
        # Round 3: 3 AK kills → not a deagle highlight
        _death(100, 3, 1, 10, weapon="ak47"),
        _death(150, 3, 1, 11, weapon="ak47"),
        _death(200, 3, 1, 12, weapon="ak47"),
    ]
    hl = _find(deaths, weapons={"deagle"}, min_kills=3)
    assert [(h["round_number"], h["kills"], h["weapon_kills"]) for h in hl] == [
        (1, 3, 3),
        (2, 3, 2),
    ]
    h = hl[0]
    assert h["side"] == "CT" and h["round_won"] is True
    assert h["first_kill_tick"] == 100 and h["last_kill_tick"] == 228
    assert h["duration_s"] == 2.0
    assert h["kill_list"][0] == {
        "tick": 100,
        "victim_id": "10",
        "victim_name": "t10",
        "weapon": "deagle",
        "headshot": True,
        "matches": True,
        "after_round_end": False,
    }
    # The kill list covers every kill, flagging which used a chosen weapon.
    assert [k["matches"] for k in hl[1]["kill_list"]] == [True, False, True]

    # Requiring 3 deagle kills keeps only the all-deagle round.
    hl = _find(deaths, weapons={"deagle"}, min_kills=3, min_weapon_kills=3)
    assert [h["round_number"] for h in hl] == [1]

    # Without a weapon filter every 3K qualifies.
    assert [h["round_number"] for h in _find(deaths, min_kills=3)] == [1, 2, 3]


def test_multiple_weapons_are_pooled():
    deaths = [
        _death(100, 1, 1, 10, weapon="deagle"),
        _death(150, 1, 1, 11, weapon="awp"),
        _death(200, 1, 1, 12, weapon="ak47"),
    ]
    hl = _find(deaths, weapons={"deagle", "awp"}, min_kills=3, min_weapon_kills=2)
    assert hl[0]["weapon_kills"] == 2
    assert _find(deaths, weapons={"deagle", "awp"}, min_kills=3, min_weapon_kills=3) == []
    # Aliases / prefixed tokens are normalised on both sides.
    assert _find(deaths, weapons={"weapon_deagle", "Desert_Eagle"}, min_kills=3)


def test_ace_and_min_kills_threshold():
    deaths = [_death(100 + i, 3, 1, 10 + i) for i in range(5)]
    assert _find(deaths, weapons={"deagle"}, min_kills=5)[0]["kills"] == 5
    assert _find(deaths[:4], weapons={"deagle"}, min_kills=5) == []


def test_teamkills_suicides_knife_round_and_other_players_ignored():
    deaths = [
        _death(100, 1, 1, 10),
        _death(110, 1, 1, 2),  # teamkill on P2
        _death(120, 1, 1, 1),  # suicide
        _death(130, 1, 2, 11),
        _death(140, 1, 2, 12),  # teammate's kills
        _death(50, 0, 1, 10),
        _death(51, 0, 1, 11),
        _death(52, 0, 1, 12),  # knife round
    ]
    assert _find(deaths, min_kills=2) == []


def test_exit_frags_after_round_end_count_for_that_round():
    # The parser stores kills between round_end and the next round_start as round 0.
    rounds = [
        {
            "round_number": 1,
            "is_knife_round": False,
            "winner_team": "CT",
            "start_tick": 0,
            "end_tick": 1000,
        },
        {
            "round_number": 2,
            "is_knife_round": False,
            "winner_team": "T",
            "start_tick": 1500,
            "end_tick": 2500,
        },
    ]
    deaths = [
        _death(-50, 0, 1, 13),  # warmup, before round 1 → never counts
        _death(500, 1, 1, 10),
        _death(900, 1, 1, 11),
        _death(1100, 0, 1, 12),  # exit frag after round 1 ended
    ]
    hl = find_highlights(rounds, deaths, SIDES, {1}, NAMES, 64.0, min_kills=3)
    assert [(h["round_number"], h["kills"]) for h in hl] == [(1, 3)]
    assert hl[0]["last_kill_tick"] == 1100
    assert [k["after_round_end"] for k in hl[0]["kill_list"]] == [False, False, True]
    assert candidate_rounds(rounds, deaths, {1}, 3, 64.0) == {1}

    # A death long after round_end (here an 11 s-in halftime gap before round 2
    # starts at tick 5000) is not an exit frag.
    halftime = [rounds[0], {**rounds[1], "start_tick": 5000, "end_tick": 6000}]
    late = [*deaths[1:3], _death(1000 + 64 * 11, 0, 1, 12)]
    assert find_highlights(halftime, late, SIDES, {1}, NAMES, 64.0, min_kills=3) == []
    within = [*deaths[1:3], _death(1000 + 64 * 9, 0, 1, 12)]
    assert find_highlights(halftime, within, SIDES, {1}, NAMES, 64.0, min_kills=3)


def test_display_round_skips_knife_rounds():
    deaths = [_death(100 + i, 2, 1, 10 + i) for i in range(3)]
    hl = _find(deaths, min_kills=3)
    # ROUNDS has a knife round 0, so parser round 2 is the app's "Round 2" only
    # if round 0 is excluded: non-knife rounds are 1, 2, 3 → display 2.
    assert hl[0]["round_number"] == 2 and hl[0]["display_round"] == 2
    rounds = [
        {"round_number": 1, "is_knife_round": True, "winner_team": ""},
        {"round_number": 2, "is_knife_round": False, "winner_team": "CT"},
    ]
    hl = find_highlights(rounds, deaths, SIDES, {1}, NAMES, 64.0, min_kills=3)
    assert hl[0]["round_number"] == 2 and hl[0]["display_round"] == 1


def test_candidate_rounds_is_a_superset_of_highlight_rounds():
    deaths = [
        _death(100, 1, 1, 10),
        _death(110, 1, 1, 2),
        _death(120, 1, 1, 11),  # 1 TK
        _death(100, 2, 1, 10),
        _death(110, 2, 1, 1),  # suicide
    ]
    assert candidate_rounds(ROUNDS, deaths, {1}, 3, 64.0) == {1}
    assert _find(deaths, min_kills=3) == []  # the team kill drops round 1


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


def _ev(tick, rn, atk, vic, weapon):
    return SimpleNamespace(
        tick=tick,
        round_number=rn,
        event_type="player_death",
        attacker_id=atk,
        victim_id=vic,
        weapon=weapon,
        headshot=False,
    )


def _parsed(player_name):
    mi = SimpleNamespace(map_name="de_mirage", tick_rate=64.0, total_ticks=1000)
    rnd = SimpleNamespace(
        round_number=1,
        start_tick=0,
        end_tick=900,
        freeze_end_tick=10,
        winner_team="CT",
        win_reason="elimination",
        ct_score=1,
        t_score=0,
        bomb_planted_tick=None,
        bomb_defused_tick=None,
        bomb_exploded_tick=None,
        is_knife_round=False,
        ct_equip_value=4000,
        t_equip_value=800,
    )
    pos = [
        SimpleNamespace(
            tick=0,
            round_number=1,
            player_id=pid,
            x=0.0,
            y=0.0,
            z=0.0,
            team_num=team,
            is_alive=1,
            yaw=0.0,
        )
        for pid, team in ((76561198000000001, 3), (11, 2), (12, 2), (13, 2), (14, 2))
    ]
    return SimpleNamespace(
        match_info=mi,
        rounds=[rnd],
        players=[
            SimpleNamespace(player_id=76561198000000001, name=player_name, initial_team="CT"),
            *[
                SimpleNamespace(player_id=v, name=f"t{v}", initial_team="T")
                for v in (11, 12, 13, 14)
            ],
        ],
        positions=pos,
        events=[
            _ev(100, 1, 76561198000000001, 11, "deagle"),
            _ev(200, 1, 76561198000000001, 12, "deagle"),
            _ev(300, 1, 76561198000000001, 13, "deagle"),
            _ev(400, 1, 76561198000000001, 14, "ak47"),
        ],
        grenades=[],
        player_state_events=[],
    )


@pytest.mark.asyncio
async def test_highlights_route_matches_name_case_insensitively():
    await store_demo(_parsed("Qiyarah"), "hl-a", "a.dem")
    await store_demo(_parsed("someone_else"), "hl-b", "b.dem")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/highlights",
            json={
                "demo_ids": ["hl-a", "hl-b", "missing"],
                "player": "  qiyarah ",
                "weapons": ["deagle"],
                "min_kills": 3,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1 and body["weapons"] == ["deagle"]
        assert body["min_weapon_kills"] == 1
        a, b, missing = body["demos"]
        assert a["matched_players"] == [{"player_id": "76561198000000001", "name": "Qiyarah"}]
        # 3 deagle + 1 AK → a 4K with 3 deagle kills.
        assert a["highlights"][0]["kills"] == 4 and a["highlights"][0]["weapon_kills"] == 3
        assert b["matched_players"] == [] and b["highlights"] == []
        assert missing["error"] == "Demo not found"

        # SteamID lookup works regardless of name; any-weapon 4k.
        resp = await client.post(
            "/api/highlights",
            json={
                "demo_ids": ["hl-b"],
                "player": "76561198000000001",
                "min_kills": 4,
            },
        )
        assert resp.json()["demos"][0]["highlights"][0]["kills"] == 4

        names = (await client.get("/api/highlights/player-names")).json()
        assert {"name": "Qiyarah", "demos": 1} in names


@pytest.mark.asyncio
async def test_same_name_players_are_never_pooled():
    # Two different SteamIDs both named "dup", 2 kills each in round 1.
    parsed = _parsed("dup")
    other = 76561198000000002
    parsed.players.append(SimpleNamespace(player_id=other, name="DUP", initial_team="CT"))
    parsed.positions.append(
        SimpleNamespace(
            tick=0,
            round_number=1,
            player_id=other,
            x=0.0,
            y=0.0,
            z=0.0,
            team_num=3,
            is_alive=1,
            yaw=0.0,
        )
    )
    parsed.events = [
        _ev(100, 1, 76561198000000001, 11, "deagle"),
        _ev(200, 1, 76561198000000001, 12, "deagle"),
        _ev(300, 1, other, 13, "deagle"),
        _ev(400, 1, other, 14, "deagle"),
    ]
    await store_demo(parsed, "hl-dup", "dup.dem")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        body = (
            await client.post(
                "/api/highlights", json={"demo_ids": ["hl-dup"], "player": "dup", "min_kills": 3}
            )
        ).json()
        assert len(body["demos"][0]["matched_players"]) == 2
        assert body["total"] == 0  # 2 + 2 kills by different players is not a 4K
        body = (
            await client.post(
                "/api/highlights", json={"demo_ids": ["hl-dup"], "player": "dup", "min_kills": 2}
            )
        ).json()
        hl = body["demos"][0]["highlights"]
        assert sorted(h["player_id"] for h in hl) == ["76561198000000001", "76561198000000002"]
        assert all(h["kills"] == 2 for h in hl)


@pytest.mark.asyncio
async def test_fetch_round_sides_can_be_restricted_to_rounds():
    await store_demo(_parsed("sides"), "hl-sides", "s.dem")
    async with get_connection() as conn:
        assert (await fetch_round_sides(conn, "hl-sides", rounds={1}))[1][11] == "T"
        assert await fetch_round_sides(conn, "hl-sides", rounds={7}) == {}
        assert await fetch_round_sides(conn, "hl-sides", rounds=set()) == {}


@pytest.mark.asyncio
async def test_highlights_route_validates_payload():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/highlights", json={"demo_ids": [], "player": "x"})
        assert resp.status_code == 422
        resp = await client.post(
            "/api/highlights", json={"demo_ids": ["a"], "player": "x", "min_kills": 9}
        )
        assert resp.status_code == 422
