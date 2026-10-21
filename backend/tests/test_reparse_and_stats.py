"""Tests for the demo 'outdated' flag, POST /demos/{id}/reparse, and exit frags
in the scoreboard."""

import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from httpx import ASGITransport, AsyncClient

from api.routes import demos as demos_routes
from db.database import get_connection, store_demo
from main import app
from parser.demo_parser import PARSER_VERSION

P = 76561198000000001  # the player (CT)
ENEMIES = (11, 12, 13, 14)


def _parsed(events, end_tick=900):
    mi = SimpleNamespace(map_name="de_mirage", tick_rate=64.0, total_ticks=5000)
    rounds = [
        SimpleNamespace(
            round_number=rn,
            start_tick=start,
            end_tick=start + end_tick,
            freeze_end_tick=start + 10,
            winner_team="CT",
            win_reason="elimination",
            ct_score=rn,
            t_score=0,
            bomb_planted_tick=None,
            bomb_defused_tick=None,
            bomb_exploded_tick=None,
            is_knife_round=False,
            ct_equip_value=4000,
            t_equip_value=4000,
        )
        for rn, start in ((1, 0), (2, 2000))
    ]
    positions = [
        SimpleNamespace(
            tick=t,
            round_number=rn,
            player_id=pid,
            x=0.0,
            y=0.0,
            z=0.0,
            team_num=team,
            is_alive=1,
            yaw=0.0,
        )
        for rn, t in ((1, 0), (2, 2000))
        for pid, team in ((P, 3), *((v, 2) for v in ENEMIES))
    ]
    return SimpleNamespace(
        match_info=mi,
        rounds=rounds,
        players=[
            SimpleNamespace(player_id=P, name="Qiyarah", initial_team="CT"),
            *(SimpleNamespace(player_id=v, name=f"t{v}", initial_team="T") for v in ENEMIES),
        ],
        positions=positions,
        events=events,
        grenades=[],
        player_state_events=[],
    )


def _kill(tick, rn, vic):
    return SimpleNamespace(
        tick=tick,
        round_number=rn,
        event_type="player_death",
        attacker_id=P,
        victim_id=vic,
        weapon="ak47",
        headshot=False,
    )


@pytest.fixture
def stored_dir(tmp_path, monkeypatch):
    """Point the stored-demo directory at a temp dir."""
    monkeypatch.setattr(demos_routes, "_demo_file_path", lambda i: tmp_path / f"{i}.dem")
    monkeypatch.setattr(demos_routes, "_UPLOAD_DIR", tmp_path / "uploads")
    return tmp_path


async def _set_parser_version(demo_id, version):
    async with get_connection() as conn:
        await conn.execute(
            "UPDATE demos SET meta_json = ? WHERE id = ?",
            (json.dumps({"parser_version": version}), demo_id),
        )
        await conn.commit()


@pytest.mark.asyncio
async def test_demo_list_reports_outdated_and_reparsable(stored_dir):
    await store_demo(_parsed([]), "rp-new", "new.dem")
    await store_demo(_parsed([]), "rp-old", "old.dem")
    await _set_parser_version("rp-old", PARSER_VERSION - 1)
    (stored_dir / "rp-old.dem").write_bytes(b"HL2DEMO")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        rows = {d["id"]: d for d in (await client.get("/api/demos")).json()}
        assert rows["rp-new"]["outdated"] is False and rows["rp-new"]["reparsable"] is False
        assert rows["rp-old"]["outdated"] is True and rows["rp-old"]["reparsable"] is True
        assert "meta_json" not in rows["rp-old"]
        one = (await client.get("/api/demos/rp-old")).json()
        assert one["outdated"] is True and "meta_json" not in one


@pytest.mark.asyncio
async def test_reparse_uses_the_stored_file(stored_dir, monkeypatch):
    await store_demo(_parsed([]), "rp-file", "match.dem")
    (stored_dir / "rp-file.dem").write_bytes(b"HL2DEMO-bytes")
    calls = []

    async def fake_start(dem_path, filename, *, force=False):
        calls.append(
            (dem_path.read_bytes(), filename, force, dem_path != stored_dir / "rp-file.dem")
        )
        return {"job_id": "j1", "demo_id": "rp-file", "cached": False}

    monkeypatch.setattr(demos_routes, "start_parse_job", fake_start)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/demos/rp-file/reparse")
        assert resp.status_code == 200 and resp.json()["job_id"] == "j1"
        # Parsed a temporary copy (the parse task deletes its input), forced.
        assert calls == [(b"HL2DEMO-bytes", "match.dem", True, True)]
        assert (stored_dir / "rp-file.dem").exists()

        assert (await client.post("/api/demos/missing/reparse")).status_code == 404
        await store_demo(_parsed([]), "rp-nofile", "gone.dem")
        resp = await client.post("/api/demos/rp-nofile/reparse")
        assert resp.status_code == 409 and "upload it again" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_scoreboard_counts_exit_frags():
    # Round 1 ends at tick 900. Two kills in the round plus one exit frag 3 s
    # after round end, which the parser stores as round 0.
    events = [_kill(100, 1, 11), _kill(200, 1, 12), _kill(900 + 192, 0, 13)]
    await store_demo(_parsed(events), "sb-exit", "e.dem")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        rows = (await client.get("/api/demos/sb-exit/scoreboard")).json()["players"]
    me = next(r for r in rows if r["player_id"] == P)
    assert me["kills"] == 3
    assert me["multikills"]["3"] == 1
    victim = next(r for r in rows if r["player_id"] == 13)
    assert victim["deaths"] == 1
