"""Tests for db.database — store_demo upsert, file_hash, query helpers."""

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest

from db.database import (
    build_positions_query,
    demo_exists,
    fetch_round_sides,
    file_hash,
    get_connection,
    store_demo,
)


def _pos(rn, pid, team_num, tick=0):
    return SimpleNamespace(
        tick=tick, round_number=rn, player_id=pid,
        x=0.0, y=0.0, z=0.0, team_num=team_num, is_alive=1, yaw=0.0,
    )


def _parsed():
    mi = SimpleNamespace(map_name="de_dust2", tick_rate=64.0, total_ticks=1000)
    rnd = SimpleNamespace(
        round_number=1, start_tick=0, end_tick=100, freeze_end_tick=10,
        winner_team="CT", win_reason="elimination", ct_score=1, t_score=0,
        bomb_planted_tick=None, bomb_defused_tick=None, bomb_exploded_tick=None,
        is_knife_round=False, ct_equip_value=4000, t_equip_value=800,
    )
    return SimpleNamespace(
        match_info=mi,
        rounds=[rnd],
        players=[SimpleNamespace(player_id=100, name="A", initial_team="CT")],
        positions=[_pos(1, 100, 3), _pos(1, 200, 2)],
        events=[],
        grenades=[],
        player_state_events=[],
    )


@pytest.mark.asyncio
async def test_store_demo_upsert_is_idempotent():
    demo_id = "reparse-test"
    await store_demo(_parsed(), demo_id, "m.dem", file_size=10)
    await store_demo(_parsed(), demo_id, "m.dem", file_size=10)  # re-parse path

    assert await demo_exists(demo_id)
    async with get_connection() as conn:
        cur = await conn.execute("SELECT COUNT(*) n FROM demos WHERE id = ?", (demo_id,))
        assert (await cur.fetchone())["n"] == 1
        cur = await conn.execute("SELECT COUNT(*) n FROM rounds WHERE demo_id = ?", (demo_id,))
        assert (await cur.fetchone())["n"] == 1  # children replaced, not duplicated
        cur = await conn.execute(
            "SELECT COUNT(*) n FROM player_positions WHERE demo_id = ?", (demo_id,)
        )
        assert (await cur.fetchone())["n"] == 2


@pytest.mark.asyncio
async def test_fetch_round_sides_maps_team_num():
    demo_id = "sides-test"
    await store_demo(_parsed(), demo_id, "m.dem")
    async with get_connection() as conn:
        sides = await fetch_round_sides(conn, demo_id)
    assert sides == {1: {100: "CT", 200: "T"}}


def test_file_hash_head_tail_size(tmp_path):
    # Two files sharing a long identical prefix but differing tail must differ.
    prefix = b"HL2DEMO" + b"\x00" * (9 << 20)  # > 2*chunk so the tail is hashed
    a = tmp_path / "a.dem"
    b = tmp_path / "b.dem"
    a.write_bytes(prefix + b"AAAA")
    b.write_bytes(prefix + b"BBBB")
    assert file_hash(a) != file_hash(b)
    # Identical content hashes equal.
    c = tmp_path / "c.dem"
    c.write_bytes(prefix + b"AAAA")
    assert file_hash(a) == file_hash(c)


def test_build_positions_query_shapes():
    q, p = build_positions_query("d", [1, 2], team_num=3, steam_ids=[765611], exclude_freeze=True)
    assert "JOIN rounds r" in q and "freeze_end_tick" in q
    assert "pp.team_num = ?" in q and "pp.player_id IN (?)" in q
    assert p == ["d", 1, 2, 3, 765611]

    q2, p2 = build_positions_query("d", [5], exclude_freeze=False)
    assert "JOIN rounds" not in q2 and "team_num = ?" not in q2
    assert p2 == ["d", 5]
