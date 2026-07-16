"""Tests for the FACEIT integration routes."""

import gzip
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from httpx import ASGITransport, AsyncClient

from api.routes import faceit
from main import app


@pytest.fixture(autouse=True)
def _reset_faceit_caches():
    """FACEIT response caches persist across calls — clear them per test so
    the monkeypatched _faceit_get is always exercised."""
    faceit._history_cache.clear()
    faceit._round_stats_cache.clear()
    yield
    faceit._history_cache.clear()
    faceit._round_stats_cache.clear()


# ---------------------------------------------------------------------------
# Helpers to build fake FACEIT history / stats payloads
# ---------------------------------------------------------------------------


def _player(pid: str, nick: str = "", skill: int = 10) -> dict:
    return {"player_id": pid, "nickname": nick or pid, "skill_level": skill}


def _history_item(match_id: str, faction1: list[str], faction2: list[str], started: int) -> dict:
    return {
        "match_id": match_id,
        "started_at": started,
        "finished_at": started + 1800,
        "competition_name": "5v5",
        "competition_type": "matchmaking",
        "region": "EU",
        "faceit_url": "https://www.faceit.com/{lang}/cs2/room/" + match_id,
        "results": {"winner": "faction1", "score": {"faction1": 13, "faction2": 7}},
        "teams": {
            "faction1": {"team_id": "t1", "players": [_player(p) for p in faction1]},
            "faction2": {"team_id": "t2", "players": [_player(p) for p in faction2]},
        },
    }


def _round(map_name: str | None, winner_team: str, teams: dict[str, list[str]]) -> dict:
    rs: dict = {"Winner": winner_team}
    if map_name is not None:
        rs["Map"] = map_name
    return {
        "round_stats": rs,
        "teams": [
            {"team_id": tid, "players": [{"player_id": p} for p in pids]}
            for tid, pids in teams.items()
        ],
    }


# ---------------------------------------------------------------------------
# _filter_common_matches (pure)
# ---------------------------------------------------------------------------


def test_filter_keeps_only_matches_with_all_players() -> None:
    history = [
        _history_item("m1", ["A", "B", "X"], ["C", "D", "E"], 300),
        _history_item("m2", ["A", "Z"], ["C", "D", "E"], 200),  # B absent
        _history_item("m3", ["A", "B"], ["C", "D"], 100),
    ]
    got = faceit._filter_common_matches(history, ["A", "B"], same_team=True)
    assert [m.match_id for m in got] == ["m1", "m3"]  # sorted by started_at desc


def test_filter_same_team_excludes_cross_faction() -> None:
    history = [_history_item("m1", ["A", "X"], ["B", "Y"], 100)]  # A vs B, opposing
    assert faceit._filter_common_matches(history, ["A", "B"], same_team=True) == []
    # Same match qualifies when same_team is not required.
    loose = faceit._filter_common_matches(history, ["A", "B"], same_team=False)
    assert [m.match_id for m in loose] == ["m1"]


def test_filter_reports_faction_labels() -> None:
    history = [_history_item("m1", ["A", "B"], ["C", "D"], 100)]
    m = faceit._filter_common_matches(history, ["A", "B"], same_team=True)[0]
    assert {p.player_id: p.faction for p in m.selected_players} == {
        "A": "faction1",
        "B": "faction1",
    }
    assert m.faceit_url.endswith("/en/cs2/room/m1")  # {lang} substituted
    assert m.score == "13 : 7"


# ---------------------------------------------------------------------------
# _aggregate_map_stats (pure)
# ---------------------------------------------------------------------------


def test_aggregate_map_stats_counts_and_winrate() -> None:
    rounds = [
        _round("de_mirage", "t1", {"t1": ["A", "B"], "t2": ["C", "D"]}),  # win
        _round("de_mirage", "t2", {"t1": ["A", "B"], "t2": ["C", "D"]}),  # loss
        _round("de_nuke", "t1", {"t1": ["A", "B"], "t2": ["C", "D"]}),  # win
        _round(None, "t1", {"t1": ["A", "B"], "t2": ["C", "D"]}),  # no map -> skipped
    ]
    maps = faceit._aggregate_map_stats(rounds, ["A", "B"])
    by = {m.map: m for m in maps}
    assert set(by) == {"de_mirage", "de_nuke"}
    assert maps[0].map == "de_mirage"  # most played first
    assert by["de_mirage"].played == 2
    assert by["de_mirage"].wins == 1
    assert by["de_mirage"].losses == 1
    assert by["de_mirage"].win_rate == 0.5
    assert by["de_mirage"].preference_pct == round(2 / 3, 4)
    assert by["de_nuke"].win_rate == 1.0
    assert by["de_nuke"].preference_pct == round(1 / 3, 4)


def test_aggregate_map_stats_no_win_when_stack_team_not_found() -> None:
    # Stack split across teams -> no team contains the whole stack -> no win.
    rounds = [_round("de_train", "t1", {"t1": ["A", "C"], "t2": ["B", "D"]})]
    maps = faceit._aggregate_map_stats(rounds, ["A", "B"])
    assert maps[0].played == 1 and maps[0].wins == 0


# ---------------------------------------------------------------------------
# _extract_player_map_segments (pure)
# ---------------------------------------------------------------------------


def test_extract_player_map_segments() -> None:
    stats = {
        "segments": [
            {
                "type": "Map",
                "mode": "5v5",
                "label": "de_mirage",
                "stats": {"Matches": "120", "Win Rate %": "58", "Average K/D Ratio": "1.10"},
            },
            {
                "type": "Map",
                "mode": "5v5",
                "label": "de_nuke",
                "stats": {"Matches": "40", "Win Rate %": "50", "Average K/D Ratio": "0.95"},
            },
            # Same map under a non-5v5 mode — the 5v5 segment must win.
            {
                "type": "Map",
                "mode": "Wingman",
                "label": "de_mirage",
                "stats": {"Matches": "5", "Win Rate %": "20", "Average K/D Ratio": "0.5"},
            },
            # Zero matches -> skipped.
            {"type": "Map", "mode": "5v5", "label": "de_dust2", "stats": {"Matches": "0"}},
            # Not a map segment -> ignored.
            {"type": "Overall", "label": "x", "stats": {"Matches": "9"}},
        ]
    }
    segs = faceit._extract_player_map_segments(stats)
    by = {s.map: s for s in segs}
    assert [s.map for s in segs] == ["de_mirage", "de_nuke"]  # sorted alphabetically
    assert by["de_mirage"].matches == 120
    assert by["de_mirage"].win_rate == 0.58
    assert by["de_mirage"].kd == 1.1
    assert "de_dust2" not in by


# ---------------------------------------------------------------------------
# _prepare_dem (gzip magic-byte branch)
# ---------------------------------------------------------------------------


def test_prepare_dem_gunzips_and_passthrough(tmp_path) -> None:
    raw = b"HL2DEMO\x00fake-demo-bytes" * 100

    gz_src = tmp_path / "in.gz"
    gz_src.write_bytes(gzip.compress(raw))
    gz_dest = tmp_path / "out_gz.dem"
    faceit._prepare_dem(gz_src, gz_dest)
    assert gz_dest.read_bytes() == raw  # gunzipped

    raw_src = tmp_path / "in.raw"
    raw_src.write_bytes(raw)
    raw_dest = tmp_path / "out_raw.dem"
    faceit._prepare_dem(raw_src, raw_dest)
    assert raw_dest.read_bytes() == raw  # copied unchanged


def test_prepare_dem_decompresses_zstd(tmp_path) -> None:
    import zstandard

    raw = b"HL2DEMO\x00fake-demo-bytes" * 100
    zst_src = tmp_path / "in.zst"
    zst_src.write_bytes(zstandard.ZstdCompressor().compress(raw))
    zst_dest = tmp_path / "out_zst.dem"
    faceit._prepare_dem(zst_src, zst_dest)
    assert zst_dest.read_bytes() == raw  # zstd-decompressed


def test_compression_kind_detects_magic_bytes(tmp_path) -> None:
    import zstandard

    from api.routes._shared import compression_kind

    raw = b"HL2DEMO\x00demo"
    gz = tmp_path / "a.bin"
    gz.write_bytes(gzip.compress(raw))
    zst = tmp_path / "b.bin"
    zst.write_bytes(zstandard.ZstdCompressor().compress(raw))
    plain = tmp_path / "c.bin"
    plain.write_bytes(raw)

    assert compression_kind(gz) == "gzip"
    assert compression_kind(zst) == "zstd"
    assert compression_kind(plain) is None


def test_clean_demo_name_strips_compression_suffix() -> None:
    from api.routes.demos import _clean_demo_name

    assert _clean_demo_name("match.dem.zst") == "match.dem"
    assert _clean_demo_name("match.dem.gz") == "match.dem"
    assert _clean_demo_name("match.zst") == "match.dem"
    assert _clean_demo_name("match.dem") == "match.dem"


# ---------------------------------------------------------------------------
# DoH resolution + IP-pinned download (CDN DNS-block fallback)
# ---------------------------------------------------------------------------


class _FakeResp:
    def __init__(self, status: int, payload: dict) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> dict:
        return self._payload


class _FakeCDNClient:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self._status = status

    async def get(self, url, params=None, headers=None, timeout=None):
        return _FakeResp(self._status, self._payload)


@pytest.mark.asyncio
async def test_doh_resolve_filters_a_records(monkeypatch) -> None:
    payload = {
        "Answer": [
            {"type": 5, "data": "cname.example.net"},  # CNAME, ignored
            {"type": 1, "data": "104.16.0.1"},
            {"type": 1, "data": "104.16.0.2"},
        ]
    }

    async def fake_cdn():
        return _FakeCDNClient(payload)

    monkeypatch.setattr(faceit, "_get_cdn_client", fake_cdn)
    ips = await faceit._doh_resolve("demos.faceit-cdn.net")
    assert ips == ["104.16.0.1", "104.16.0.2"]


@pytest.mark.asyncio
async def test_doh_resolve_returns_empty_on_no_answer(monkeypatch) -> None:
    async def fake_cdn():
        return _FakeCDNClient({"Answer": []})

    monkeypatch.setattr(faceit, "_get_cdn_client", fake_cdn)
    assert await faceit._doh_resolve("nope.example") == []


# ---------------------------------------------------------------------------
# Endpoints (mocked _faceit_get)
# ---------------------------------------------------------------------------


async def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_resolve_reports_per_nickname_status(monkeypatch) -> None:
    monkeypatch.setenv("FACEIT_API_KEY", "test-key")

    async def fake_get(path, params=None, *, allow_404=False):
        nick = (params or {}).get("nickname")
        if nick == "good":
            return {"player_id": "p1", "nickname": "good", "games": {"cs2": {"skill_level": 9}}}
        if nick == "nocs2":
            return {"player_id": "p2", "nickname": "nocs2", "games": {"csgo": {}}}
        return None  # 404 -> not found

    monkeypatch.setattr(faceit, "_faceit_get", fake_get)

    async with await _client() as c:
        resp = await c.post("/api/faceit/resolve", json={"nicknames": ["good", "nocs2", "ghost"]})
    assert resp.status_code == 200
    players = {p["nickname"]: p for p in resp.json()["players"]}
    assert players["good"]["found"] is True and players["good"]["player_id"] == "p1"
    assert players["nocs2"]["found"] is False and players["nocs2"]["error"] == "No CS2 profile"
    assert players["ghost"]["found"] is False and players["ghost"]["error"] == "Nickname not found"


@pytest.mark.asyncio
async def test_missing_api_key_returns_503(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("FACEIT_API_KEY", raising=False)
    monkeypatch.setattr(faceit, "_CONFIG_FILE", tmp_path / "none.json")  # no saved key
    async with await _client() as c:
        resp = await c.post("/api/faceit/resolve", json={"nicknames": ["anyone"]})
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_load_match_without_demo_returns_409(monkeypatch) -> None:
    monkeypatch.setenv("FACEIT_API_KEY", "test-key")

    async def fake_get(path, params=None, *, allow_404=False):
        assert path == "/matches/m-1"
        return {"match_id": "m-1", "demo_url": []}  # no demo

    monkeypatch.setattr(faceit, "_faceit_get", fake_get)

    async with await _client() as c:
        resp = await c.post("/api/faceit/load-match", json={"match_id": "m-1"})
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_config_reports_env_source(monkeypatch) -> None:
    monkeypatch.setenv("FACEIT_API_KEY", "env-key")
    async with await _client() as c:
        resp = await c.get("/api/faceit/config")
    assert resp.status_code == 200
    assert resp.json() == {"configured": True, "source": "env"}


@pytest.mark.asyncio
async def test_config_save_validate_and_clear(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("FACEIT_API_KEY", raising=False)
    monkeypatch.setattr(faceit, "_CONFIG_FILE", tmp_path / "config.json")

    validated: list[str] = []

    async def fake_validate(key: str) -> None:
        validated.append(key)  # accept any key

    monkeypatch.setattr(faceit, "_validate_key", fake_validate)

    async with await _client() as c:
        # Initially nothing is configured.
        assert (await c.get("/api/faceit/config")).json() == {
            "configured": False,
            "source": None,
        }
        # Empty key is rejected.
        assert (await c.post("/api/faceit/config", json={"api_key": "  "})).status_code == 400
        # Saving validates then persists.
        saved = await c.post("/api/faceit/config", json={"api_key": "real-key"})
        assert saved.status_code == 200
        assert saved.json() == {"configured": True, "source": "saved"}
        assert validated == ["real-key"]
        # The saved key now drives _api_key and is reported by GET.
        assert faceit._saved_key() == "real-key"
        assert (await c.get("/api/faceit/config")).json()["source"] == "saved"
        # Clearing removes it.
        cleared = await c.delete("/api/faceit/config")
        assert cleared.json() == {"configured": False, "source": None}
        assert faceit._saved_key() == ""


@pytest.mark.asyncio
async def test_config_save_rejects_bad_key(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("FACEIT_API_KEY", raising=False)
    monkeypatch.setattr(faceit, "_CONFIG_FILE", tmp_path / "config.json")

    async def bad_validate(key: str) -> None:
        raise faceit.HTTPException(400, "FACEIT rejected this key.")

    monkeypatch.setattr(faceit, "_validate_key", bad_validate)

    async with await _client() as c:
        resp = await c.post("/api/faceit/config", json={"api_key": "nope"})
    assert resp.status_code == 400
    assert faceit._saved_key() == ""  # not persisted


@pytest.mark.asyncio
async def test_common_matches_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("FACEIT_API_KEY", "test-key")

    async def fake_get(path, params=None, *, allow_404=False):
        if "/history" in path:
            if (params or {}).get("offset", 0) == 0:
                return {
                    "items": [
                        _history_item("m1", ["A", "B"], ["C", "D"], 300),
                        _history_item("m2", ["A", "B"], ["C", "D"], 200),
                    ]
                }
            return {"items": []}
        if "/stats" in path:
            # Return a minimal stats payload with a map name.
            return {
                "rounds": [
                    _round("de_mirage", "t1", {"t1": ["A", "B"], "t2": ["C", "D"]})
                ]
            }
        return None

    monkeypatch.setattr(faceit, "_faceit_get", fake_get)

    async with await _client() as c:
        resp = await c.post(
            "/api/faceit/common-matches",
            json={"player_ids": ["A", "B"], "same_team": True, "window": 50},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert [m["match_id"] for m in body["matches"]] == ["m1", "m2"]
    assert body["analyzed"] == 2
    # Map name should be populated from the stats call.
    assert body["matches"][0]["map"] == "de_mirage"


@pytest.mark.asyncio
async def test_history_cache_dedupes_across_calls(monkeypatch) -> None:
    monkeypatch.setenv("FACEIT_API_KEY", "test-key")
    calls = {"history": 0}

    async def fake_get(path, params=None, *, allow_404=False):
        if "/history" in path:
            if (params or {}).get("offset", 0) == 0:
                calls["history"] += 1
                return {"items": [_history_item("m1", ["A", "B"], ["C", "D"], 300)]}
            return {"items": []}
        if "/stats" in path:
            return {"rounds": [_round("de_mirage", "t1", {"t1": ["A", "B"], "t2": ["C", "D"]})]}
        return None

    monkeypatch.setattr(faceit, "_faceit_get", fake_get)

    async with await _client() as c:
        payload = {"player_ids": ["A", "B"], "same_team": True, "window": 50}
        await c.post("/api/faceit/common-matches", json=payload)
        await c.post("/api/faceit/common-matches", json=payload)  # cache hit

    # The anchor player's history is fetched once, not twice.
    assert calls["history"] == 1
