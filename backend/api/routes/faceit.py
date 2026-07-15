"""
FACEIT integration routes.

Lets the user enter up to five FACEIT nicknames, find the matches those players
played together (on the same team), inspect the stack's map preferences, and
load a match's demo straight into the radar via the existing parse pipeline.

  POST /faceit/resolve          – nicknames -> player summaries (validation)
  POST /faceit/common-matches   – matches where all players were on one team
  POST /faceit/stack-map-stats  – per-map play frequency + win rate for the stack
  POST /faceit/load-match       – download a match demo, parse it, return a job

Auth: set the FACEIT_API_KEY environment variable (server-side only — the key
is never sent to the browser).  Get a free key at developers.faceit.com.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ._shared import _DATA_DIR, _MAX_UPLOAD_BYTES, _UPLOAD_DIR
from .demos import start_parse_job

logger = logging.getLogger(__name__)
router = APIRouter()

FACEIT_BASE = "https://open.faceit.com/data/v4"
_GAME = "cs2"
_MAX_PLAYERS = 5
_HISTORY_PAGE = 100  # max page size the API allows
_HISTORY_OFFSET_CAP = 1000  # max offset the API allows
_STATS_CONCURRENCY = 5
_GZIP_MAGIC = b"\x1f\x8b"

_CHUNK = 1024 * 1024  # 1 MB


# ---------------------------------------------------------------------------
# Shared HTTP clients + auth
# ---------------------------------------------------------------------------

_client: httpx.AsyncClient | None = None
_cdn_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _get_client() -> httpx.AsyncClient:
    """Lazily create one shared AsyncClient (pooled, bounded concurrency)."""
    global _client
    if _client is None or _client.is_closed:
        async with _client_lock:
            if _client is None or _client.is_closed:
                _client = httpx.AsyncClient(
                    base_url=FACEIT_BASE,
                    limits=httpx.Limits(max_connections=_STATS_CONCURRENCY),
                    timeout=httpx.Timeout(15.0, read=30.0),
                    follow_redirects=True,
                )
    return _client


async def _get_cdn_client() -> httpx.AsyncClient:
    """Separate client for CDN demo downloads — no base_url, follows redirects."""
    global _cdn_client
    if _cdn_client is None or _cdn_client.is_closed:
        async with _client_lock:
            if _cdn_client is None or _cdn_client.is_closed:
                _cdn_client = httpx.AsyncClient(
                    follow_redirects=True,
                    timeout=httpx.Timeout(30.0, read=120.0),
                )
    return _cdn_client


# The API key may come from the environment (takes precedence) or be saved
# in-app to the data folder.  The saved file lives next to the other app data.
_CONFIG_FILE = _DATA_DIR / "config.json"


def _load_config() -> dict:
    try:
        if _CONFIG_FILE.exists():
            data = json.loads(_CONFIG_FILE.read_text())
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_config(data: dict) -> None:
    """Atomically persist the config so a crash mid-write can't corrupt it."""
    _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(_CONFIG_FILE.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(data))
        os.replace(tmp, _CONFIG_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _env_key() -> str:
    return os.environ.get("FACEIT_API_KEY", "").strip()


def _saved_key() -> str:
    return (_load_config().get("faceit_api_key") or "").strip()


def _key_source() -> str | None:
    """Where the active key comes from: 'env', 'saved', or None if unset."""
    if _env_key():
        return "env"
    if _saved_key():
        return "saved"
    return None


def _api_key() -> str:
    key = _env_key() or _saved_key()
    if not key:
        raise HTTPException(
            503,
            "FACEIT integration is not configured. Add your API key in the "
            "FACEIT tab (get a free key at developers.faceit.com).",
        )
    return key


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_api_key()}", "Accept": "application/json"}


async def _validate_key(key: str) -> None:
    """Confirm a key works by making one cheap authenticated FACEIT call."""
    client = await _get_client()
    try:
        resp = await client.get(
            f"/games/{_GAME}",
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
        )
    except httpx.RequestError:
        raise HTTPException(502, "Could not reach FACEIT to validate the key. Try again.")
    if resp.status_code in (401, 403):
        raise HTTPException(
            400, "FACEIT rejected this key. Make sure you copied the full Data API key."
        )
    if resp.status_code >= 400:
        raise HTTPException(502, f"FACEIT key validation failed (HTTP {resp.status_code}).")


async def _faceit_get(
    path: str, params: dict | None = None, *, allow_404: bool = False
) -> dict | None:
    """GET a FACEIT Data API endpoint, mapping upstream errors to HTTPExceptions.

    Returns the parsed JSON dict, or ``None`` when ``allow_404`` and the
    resource does not exist (so callers can treat "not found" as a soft miss).
    """
    client = await _get_client()
    try:
        resp = await client.get(path, params=params, headers=_headers())
    except httpx.RequestError as exc:
        logger.warning("FACEIT request error for %s: %s", path, exc)
        raise HTTPException(502, "Could not reach FACEIT. Check your connection and retry.")

    if resp.status_code == 401:
        raise HTTPException(503, "FACEIT rejected the API key (401). Check FACEIT_API_KEY.")
    if resp.status_code == 429:
        raise HTTPException(503, "FACEIT rate limit reached. Please wait a moment and retry.")
    if resp.status_code == 404:
        if allow_404:
            return None
        raise HTTPException(404, "FACEIT resource not found.")
    if resp.status_code >= 400:
        logger.warning("FACEIT %s -> %s: %s", path, resp.status_code, resp.text[:200])
        raise HTTPException(502, f"FACEIT returned an error (HTTP {resp.status_code}).")

    try:
        data = resp.json()
    except ValueError:
        raise HTTPException(502, "FACEIT returned a malformed response.")
    return data if isinstance(data, dict) else {"items": data}


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class ResolvePayload(BaseModel):
    nicknames: list[str]


class ResolvedPlayer(BaseModel):
    nickname: str
    player_id: str | None = None
    avatar: str = ""
    country: str = ""
    skill_level: int | None = None
    found: bool = False
    error: str | None = None


class ResolveResponse(BaseModel):
    players: list[ResolvedPlayer]


class CommonMatchesPayload(BaseModel):
    player_ids: list[str]
    same_team: bool = True
    window: int = 300


class SelectedPlayerInMatch(BaseModel):
    player_id: str
    nickname: str
    faction: str  # "faction1" | "faction2"
    skill_level: int | None = None


class MatchSummary(BaseModel):
    match_id: str
    started_at: int
    finished_at: int
    competition_name: str
    competition_type: str
    region: str
    faceit_url: str
    score: str
    selected_players: list[SelectedPlayerInMatch]
    map: str | None = None


class CommonMatchesResponse(BaseModel):
    matches: list[MatchSummary]
    analyzed: int  # how many of the anchor player's matches were scanned


class MapStatsPayload(BaseModel):
    player_ids: list[str]
    same_team: bool = True
    window: int = 300
    max_matches: int = 60


class MapStat(BaseModel):
    map: str
    played: int
    wins: int
    losses: int
    win_rate: float  # 0..1, fraction of analyzed games on this map that were won
    preference_pct: float  # 0..1, share of analyzed games played on this map


class MapStatsResponse(BaseModel):
    total_matches: int
    analyzed: int
    maps: list[MapStat]


class PlayerMapStatsPayload(BaseModel):
    player_ids: list[str]


class PlayerMapSegment(BaseModel):
    map: str
    matches: int
    win_rate: float  # 0..1
    kd: float


class PlayerMapStats(BaseModel):
    player_id: str
    maps: list[PlayerMapSegment]


class PlayerMapStatsResponse(BaseModel):
    players: list[PlayerMapStats]


class LoadMatchPayload(BaseModel):
    match_id: str


class ApiKeyPayload(BaseModel):
    api_key: str


class ConfigResponse(BaseModel):
    configured: bool
    source: str | None  # "env" | "saved" | None


# ---------------------------------------------------------------------------
# API-key configuration (in-app entry, persisted to the data folder)
# ---------------------------------------------------------------------------


@router.get("/faceit/config", response_model=ConfigResponse)
async def get_config() -> ConfigResponse:
    """Report whether a key is configured and where it comes from (never the key)."""
    src = _key_source()
    return ConfigResponse(configured=src is not None, source=src)


@router.post("/faceit/config", response_model=ConfigResponse)
async def set_config(payload: ApiKeyPayload) -> ConfigResponse:
    """Validate an API key against FACEIT and save it to the data folder."""
    key = (payload.api_key or "").strip()
    if not key:
        raise HTTPException(400, "API key must not be empty.")
    await _validate_key(key)
    cfg = _load_config()
    cfg["faceit_api_key"] = key
    _save_config(cfg)
    logger.info("FACEIT API key saved via in-app configuration.")
    return ConfigResponse(configured=True, source=_key_source())


@router.delete("/faceit/config", response_model=ConfigResponse)
async def clear_config() -> ConfigResponse:
    """Remove the saved API key (an environment key, if set, still applies)."""
    cfg = _load_config()
    cfg.pop("faceit_api_key", None)
    _save_config(cfg)
    src = _key_source()
    return ConfigResponse(configured=src is not None, source=src)


# ---------------------------------------------------------------------------
# Nickname resolution
# ---------------------------------------------------------------------------


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in items or []:
        v = (raw or "").strip()
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


async def _resolve_one(nickname: str) -> ResolvedPlayer:
    data = await _faceit_get("/players", {"nickname": nickname, "game": _GAME}, allow_404=True)
    if data is None:
        return ResolvedPlayer(nickname=nickname, found=False, error="Nickname not found")
    games = data.get("games") or {}
    common = {
        "nickname": data.get("nickname", nickname),
        "player_id": data.get("player_id"),
        "avatar": data.get("avatar") or "",
        "country": data.get("country") or "",
    }
    if _GAME not in games:
        return ResolvedPlayer(**common, found=False, error="No CS2 profile")
    game_info = games.get(_GAME) or {}
    skill = game_info.get("skill_level") if isinstance(game_info, dict) else None
    return ResolvedPlayer(**common, skill_level=skill, found=True)


@router.post("/faceit/resolve", response_model=ResolveResponse)
async def resolve_nicknames(payload: ResolvePayload) -> ResolveResponse:
    """Resolve up to five nicknames to CS2 player summaries (per-item validity)."""
    nicks = _dedupe(payload.nicknames)
    if not nicks:
        raise HTTPException(400, "Enter at least one nickname.")
    if len(nicks) > _MAX_PLAYERS:
        raise HTTPException(400, f"At most {_MAX_PLAYERS} players.")
    _api_key()  # fail fast (503) if unconfigured, before firing requests
    players = await asyncio.gather(*(_resolve_one(n) for n in nicks))
    return ResolveResponse(players=list(players))


# ---------------------------------------------------------------------------
# Common-match discovery
# ---------------------------------------------------------------------------


def _validate_ids(player_ids: list[str]) -> list[str]:
    ids = _dedupe(player_ids)
    if not ids:
        raise HTTPException(400, "Select at least one resolved player.")
    if len(ids) > _MAX_PLAYERS:
        raise HTTPException(400, f"At most {_MAX_PLAYERS} players.")
    return ids


def _index_players(item: dict) -> tuple[dict[str, str], dict[str, dict]]:
    """Return (player_id -> faction, player_id -> player-detail) for a history item."""
    factions: dict[str, str] = {}
    details: dict[str, dict] = {}
    teams = item.get("teams") or {}
    for fac in ("faction1", "faction2"):
        for p in (teams.get(fac) or {}).get("players") or []:
            pid = p.get("player_id")
            if pid:
                factions[pid] = fac
                details[pid] = p
    return factions, details


def _to_match_summary(
    item: dict, selected: list[str], factions: dict[str, str], details: dict[str, dict]
) -> MatchSummary:
    results = item.get("results") or {}
    score = results.get("score") if isinstance(results, dict) else None
    score_str = ""
    if isinstance(score, dict):
        f1, f2 = score.get("faction1"), score.get("faction2")
        if f1 is not None and f2 is not None:
            score_str = f"{f1} : {f2}"
    return MatchSummary(
        match_id=item.get("match_id", "") or "",
        started_at=int(item.get("started_at") or 0),
        finished_at=int(item.get("finished_at") or 0),
        competition_name=item.get("competition_name") or "",
        competition_type=item.get("competition_type") or "",
        region=item.get("region") or "",
        faceit_url=(item.get("faceit_url") or "").replace("{lang}", "en"),
        score=score_str,
        selected_players=[
            SelectedPlayerInMatch(
                player_id=pid,
                nickname=details.get(pid, {}).get("nickname", ""),
                faction=factions.get(pid, ""),
                skill_level=details.get(pid, {}).get("skill_level"),
            )
            for pid in selected
        ],
    )


def _filter_common_matches(
    history_items: list[dict], selected_ids: list[str], same_team: bool
) -> list[MatchSummary]:
    """Pure filter: keep matches where every selected player appears.

    With ``same_team`` also require them all to share one faction.  Anchoring on
    the first player's history makes this complete within the window, because
    any match they all co-occurred in necessarily contains the anchor.
    """
    sel = _dedupe(selected_ids)
    out: list[MatchSummary] = []
    for item in history_items:
        factions, details = _index_players(item)
        if not all(pid in factions for pid in sel):
            continue
        if same_team and len({factions[pid] for pid in sel}) != 1:
            continue
        out.append(_to_match_summary(item, sel, factions, details))
    out.sort(key=lambda m: m.started_at, reverse=True)
    return out


async def _fetch_history(player_id: str, window: int) -> list[dict]:
    """Fetch up to ``window`` recent CS2 matches from a player's history."""
    window = max(1, min(window, _HISTORY_OFFSET_CAP + _HISTORY_PAGE))
    items: list[dict] = []
    offset = 0
    while len(items) < window and offset <= _HISTORY_OFFSET_CAP:
        limit = min(_HISTORY_PAGE, window - len(items))
        data = await _faceit_get(
            f"/players/{player_id}/history",
            {"game": _GAME, "offset": offset, "limit": limit},
            allow_404=True,
        )
        page = (data or {}).get("items") or []
        if not page:
            break
        items.extend(page)
        if len(page) < limit:
            break
        offset += limit
    return items[:window]


@router.post("/faceit/common-matches", response_model=CommonMatchesResponse)
async def common_matches(payload: CommonMatchesPayload) -> CommonMatchesResponse:
    """Find matches where all selected players played (on the same team)."""
    ids = _validate_ids(payload.player_ids)
    _api_key()
    history = await _fetch_history(ids[0], payload.window)
    matches = _filter_common_matches(history, ids, payload.same_team)

    # Enrich each match with the map name from its stats.
    if matches:
        sem = asyncio.Semaphore(_STATS_CONCURRENCY)

        async def _get_map(mid: str) -> str | None:
            async with sem:
                rnd = await _fetch_match_round(mid)
            if rnd is None:
                return None
            rs = rnd.get("round_stats") or {}
            return rs.get("Map") or rs.get("map") or None

        map_names = await asyncio.gather(*(_get_map(m.match_id) for m in matches))
        matches = [
            m.model_copy(update={"map": mn})
            for m, mn in zip(matches, map_names, strict=False)
        ]

    return CommonMatchesResponse(matches=matches, analyzed=len(history))


# ---------------------------------------------------------------------------
# Stack map-preference profile
# ---------------------------------------------------------------------------


async def _fetch_match_round(match_id: str) -> dict | None:
    """Return the first round-stats object for a match, or None if unavailable."""
    try:
        data = await _faceit_get(f"/matches/{match_id}/stats", allow_404=True)
    except HTTPException:
        # A single match's stats failing must not abort the whole aggregation.
        return None
    rounds = (data or {}).get("rounds") or []
    return rounds[0] if rounds else None


def _aggregate_map_stats(round_objs: list[dict], stack_ids: list[str]) -> list[MapStat]:
    """Aggregate per-map play counts and win rate for the stack.

    Win attribution: within a match's round stats, find the team whose roster
    contains the whole stack, then compare its team_id to ``round_stats.Winner``.
    """
    sel = set(stack_ids)
    agg: dict[str, dict[str, int]] = {}
    for rnd in round_objs:
        rs = rnd.get("round_stats") or {}
        map_name = rs.get("Map") or rs.get("map")
        if not map_name:
            continue

        stack_team_id: str | None = None
        for team in rnd.get("teams") or []:
            pids = {p.get("player_id") for p in (team.get("players") or [])}
            if sel and sel.issubset(pids):
                stack_team_id = team.get("team_id")
                break

        bucket = agg.setdefault(map_name, {"played": 0, "wins": 0})
        bucket["played"] += 1
        winner = rs.get("Winner") or rs.get("winner")
        if stack_team_id is not None and winner is not None and str(winner) == str(stack_team_id):
            bucket["wins"] += 1

    total = sum(b["played"] for b in agg.values()) or 1
    out = [
        MapStat(
            map=name,
            played=b["played"],
            wins=b["wins"],
            losses=b["played"] - b["wins"],
            win_rate=round(b["wins"] / b["played"], 4) if b["played"] else 0.0,
            preference_pct=round(b["played"] / total, 4),
        )
        for name, b in agg.items()
    ]
    out.sort(key=lambda m: (m.played, m.win_rate), reverse=True)
    return out


@router.post("/faceit/stack-map-stats", response_model=MapStatsResponse)
async def stack_map_stats(payload: MapStatsPayload) -> MapStatsResponse:
    """Map preference + win-rate profile for the stack across their shared matches."""
    ids = _validate_ids(payload.player_ids)
    _api_key()
    history = await _fetch_history(ids[0], payload.window)
    matches = _filter_common_matches(history, ids, payload.same_team)
    total = len(matches)

    cap = max(1, min(payload.max_matches, 200))
    subset = matches[:cap]

    sem = asyncio.Semaphore(_STATS_CONCURRENCY)

    async def _one(match: MatchSummary) -> dict | None:
        async with sem:
            return await _fetch_match_round(match.match_id)

    rounds = await asyncio.gather(*(_one(m) for m in subset))
    usable = [r for r in rounds if r is not None]
    maps = _aggregate_map_stats(usable, ids)
    return MapStatsResponse(total_matches=total, analyzed=len(usable), maps=maps)


# ---------------------------------------------------------------------------
# Per-player map stats (lifetime, from the FACEIT stats endpoint)
# ---------------------------------------------------------------------------


def _num(v: object) -> float:
    """Parse FACEIT's stringly-typed numbers defensively."""
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return 0.0


def _extract_player_map_segments(stats_json: dict) -> list[PlayerMapSegment]:
    """Extract per-map lifetime stats from a player's stats payload.

    Segments carry a free-form ``stats`` dict; the same map can appear under
    several modes, so we prefer the 5v5 segment for each map label.
    """
    best: dict[str, tuple[int, PlayerMapSegment]] = {}
    for seg in (stats_json or {}).get("segments") or []:
        if seg.get("type") != "Map":
            continue
        label = seg.get("label") or ""
        if not label:
            continue
        s = seg.get("stats") or {}
        matches = int(_num(s.get("Matches")))
        if matches <= 0:
            continue
        seg_obj = PlayerMapSegment(
            map=label,
            matches=matches,
            win_rate=round(_num(s.get("Win Rate %")) / 100.0, 4),
            kd=round(_num(s.get("Average K/D Ratio") or s.get("K/D Ratio")), 2),
        )
        mode_rank = 2 if seg.get("mode") == "5v5" else 1
        if label not in best or mode_rank > best[label][0]:
            best[label] = (mode_rank, seg_obj)
    out = [v[1] for v in best.values()]
    out.sort(key=lambda m: m.map)
    return out


_PLAYER_STATS_WINDOW = 300      # history items fetched per player
_PLAYER_STATS_CAP = 40          # max match-stats fetches per player (bounds API calls)


@router.post("/faceit/player-map-stats", response_model=PlayerMapStatsResponse)
async def player_map_stats(payload: PlayerMapStatsPayload) -> PlayerMapStatsResponse:
    """Per-map stats for each player from their most recent 300 matches."""
    ids = _validate_ids(payload.player_ids)
    _api_key()

    # Fetch each player's recent history concurrently.
    histories: list[list[dict]] = list(
        await asyncio.gather(*(_fetch_history(pid, _PLAYER_STATS_WINDOW) for pid in ids))
    )

    # Build per-player faction map and capped match-id list.
    player_faction_map: dict[str, dict[str, str]] = {}
    player_match_ids: dict[str, list[str]] = {}
    for pid, hist in zip(ids, histories, strict=False):
        fac_map: dict[str, str] = {}
        mids: list[str] = []
        for item in hist:
            mid = item.get("match_id") or ""
            if not mid:
                continue
            factions, _ = _index_players(item)
            if pid in factions:
                fac_map[mid] = factions[pid]
                mids.append(mid)
        player_faction_map[pid] = fac_map
        player_match_ids[pid] = mids[:_PLAYER_STATS_CAP]

    # Deduplicate match IDs across players; fetch each set of stats once.
    all_match_ids = list({mid for mids in player_match_ids.values() for mid in mids})
    sem = asyncio.Semaphore(_STATS_CONCURRENCY)

    async def _one_match(mid: str) -> tuple[str, dict | None]:
        async with sem:
            rnd = await _fetch_match_round(mid)
        return mid, rnd

    results = await asyncio.gather(*(_one_match(mid) for mid in all_match_ids))
    stats_by_match: dict[str, dict] = {
        mid: rnd for mid, rnd in results if rnd is not None
    }

    # Aggregate per player, per map — sorted alphabetically.
    players_out: list[PlayerMapStats] = []
    for pid in ids:
        agg: dict[str, dict] = {}
        for mid in player_match_ids[pid]:
            rnd = stats_by_match.get(mid)
            if rnd is None:
                continue
            rs = rnd.get("round_stats") or {}
            map_name = rs.get("Map") or rs.get("map")
            if not map_name:
                continue

            player_team_id: str | None = None
            player_kd: float = 0.0
            for team in rnd.get("teams") or []:
                for p in team.get("players") or []:
                    if p.get("player_id") == pid:
                        player_team_id = team.get("team_id")
                        ps = p.get("player_stats") or {}
                        player_kd = _num(ps.get("K/D Ratio") or ps.get("Average K/D Ratio") or 0)
                        break
                if player_team_id:
                    break

            winner = rs.get("Winner") or rs.get("winner")
            won = (
                player_team_id is not None
                and winner is not None
                and str(winner) == str(player_team_id)
            )

            bucket = agg.setdefault(map_name, {"played": 0, "wins": 0, "kd_sum": 0.0})
            bucket["played"] += 1
            if won:
                bucket["wins"] += 1
            bucket["kd_sum"] = float(bucket["kd_sum"]) + player_kd

        out = [
            PlayerMapSegment(
                map=map_name,
                matches=b["played"],
                win_rate=round(b["wins"] / b["played"], 4) if b["played"] else 0.0,
                kd=round(float(b["kd_sum"]) / max(b["played"], 1), 2),
            )
            for map_name, b in sorted(agg.items())
        ]
        players_out.append(PlayerMapStats(player_id=pid, maps=out))

    return PlayerMapStatsResponse(players=players_out)


# ---------------------------------------------------------------------------
# Load a match demo into the radar
# ---------------------------------------------------------------------------


async def _stream_to_file(
    client: httpx.AsyncClient,
    url: str,
    dest: Path,
    *,
    sni_hostname: str | None = None,
    host_header: str | None = None,
) -> None:
    """Stream one URL to ``dest`` enforcing the size cap. Raises on any failure.

    When ``sni_hostname``/``host_header`` are given the URL host is expected to
    be an IP literal (DoH fallback): the TCP connection targets the IP while TLS
    SNI and the Host header preserve the real hostname, so cert verification and
    CDN routing still work.
    """
    kwargs: dict = {}
    if sni_hostname:
        kwargs["extensions"] = {"sni_hostname": sni_hostname}
    if host_header:
        kwargs["headers"] = {"Host": host_header}
    written = 0
    async with client.stream("GET", url, **kwargs) as resp:
        if resp.status_code >= 400:
            raise HTTPException(502, f"Demo download failed (HTTP {resp.status_code}).")
        with dest.open("wb") as out:
            async for chunk in resp.aiter_bytes(_CHUNK):
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413,
                        f"Demo too large (> {_MAX_UPLOAD_BYTES // 1_000_000} MB). "
                        f"Raise the limit with MAX_UPLOAD_MB.",
                    )
                out.write(chunk)


# DNS-over-HTTPS resolvers, addressed by IP so they need no DNS themselves.
# Their TLS certs include these IPs as SANs, so verification still passes.
_DOH_ENDPOINTS = ("https://1.1.1.1/dns-query", "https://8.8.8.8/resolve")


async def _doh_resolve(hostname: str) -> list[str]:
    """Resolve ``hostname`` to IPv4 addresses via DNS-over-HTTPS.

    Bypasses the local resolver, which is the usual culprit when a CDN domain
    fails to resolve (ISP DNS or a filter blocking ``*.faceit-cdn.net``) while
    the rest of the internet works.  Returns [] if every resolver fails.
    """
    client = await _get_cdn_client()
    for endpoint in _DOH_ENDPOINTS:
        try:
            resp = await client.get(
                endpoint,
                params={"name": hostname, "type": "A"},
                headers={"Accept": "application/dns-json"},
                timeout=httpx.Timeout(8.0),
            )
            if resp.status_code != 200:
                continue
            answers = resp.json().get("Answer") or []
            ips = [a["data"] for a in answers if a.get("type") == 1 and a.get("data")]
            if ips:
                logger.info("DoH resolved %s -> %s via %s", hostname, ips, endpoint)
                return ips
        except (httpx.RequestError, ValueError, KeyError) as exc:
            logger.warning("DoH resolve via %s failed: %s", endpoint, exc)
    return []


async def _download_capped(urls: list[str], dest: Path) -> None:
    """Download a demo, trying every candidate URL, with a DoH fallback.

    FACEIT can return more than one ``demo_url`` (different CDN hosts); we try
    them in order.  If a host fails to resolve locally (getaddrinfo/ConnectError)
    we resolve it via DNS-over-HTTPS and retry against the IP.  No Authorization
    header is sent — FACEIT demo URLs are pre-signed CDN links.
    """
    client = await _get_cdn_client()
    candidates = [
        u.strip()
        for u in (str(x or "").strip() for x in urls)
        if u.lower().startswith(("http://", "https://"))
    ]
    if not candidates:
        raise HTTPException(502, "FACEIT returned no usable demo URL for this match.")

    last_err = ""
    for url in candidates:
        host = urlparse(url).hostname or ""

        # 1) Direct download with a short retry for transient hiccups.
        dns_failed = False
        for attempt in range(2):
            try:
                logger.info("Downloading demo from %s (attempt %d)", host, attempt + 1)
                await _stream_to_file(client, url, dest)
                return
            except HTTPException:
                raise  # size cap / HTTP error — don't retry or mask
            except httpx.ConnectError as exc:
                last_err = f"{type(exc).__name__}: {exc}"
                dns_failed = True
                logger.warning("Demo connect to %s failed: %s", host, last_err)
                dest.unlink(missing_ok=True)
                break  # DNS/connect issue won't fix on plain retry — go to DoH
            except httpx.RequestError as exc:
                last_err = f"{type(exc).__name__}: {exc}"
                logger.warning("Demo download from %s failed: %s", host, last_err)
                dest.unlink(missing_ok=True)
                if attempt < 1:
                    await asyncio.sleep(1.0)

        # 2) DoH fallback: resolve the host ourselves and connect by IP.
        if dns_failed and host:
            for ip in await _doh_resolve(host):
                ip_url = url.replace(f"://{host}", f"://{ip}", 1)
                try:
                    logger.info("Retrying demo download via DoH IP %s for %s", ip, host)
                    await _stream_to_file(
                        client, ip_url, dest, sni_hostname=host, host_header=host
                    )
                    return
                except HTTPException:
                    raise
                except httpx.RequestError as exc:
                    last_err = f"{type(exc).__name__}: {exc}"
                    logger.warning("DoH download via %s failed: %s", ip, last_err)
                    dest.unlink(missing_ok=True)

    raise HTTPException(
        502,
        f"Demo download failed ({last_err}). The FACEIT demo host could not be "
        f"reached from this machine — usually a DNS or network block (VPN, firewall, "
        f"or a DNS filter blocking the CDN). Try again, switch DNS servers, or open "
        f"the match on FACEIT and download the demo manually.",
    )


def _prepare_dem(src: Path, dest: Path) -> None:
    """Produce a raw .dem at ``dest`` from ``src`` — gunzip if gzip-compressed.

    Detection is by magic bytes, not the URL extension.  Runs in a thread (it
    is blocking IO/CPU).  Enforces the size cap on the decompressed stream too.
    """
    with src.open("rb") as f:
        magic = f.read(2)
    if magic == _GZIP_MAGIC:
        written = 0
        with gzip.open(src, "rb") as gz, dest.open("wb") as out:
            while True:
                chunk = gz.read(_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > _MAX_UPLOAD_BYTES:
                    dest.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"Decompressed demo too large (> {_MAX_UPLOAD_BYTES // 1_000_000} MB).",
                    )
                out.write(chunk)
    else:
        shutil.copyfile(src, dest)


@router.post("/faceit/load-match")
async def load_match(payload: LoadMatchPayload) -> dict:
    """Download a FACEIT match's demo, parse it, and return a parse job.

    The frontend polls the existing /api/parse-status/{job_id} SSE stream and
    then loads the demo into the radar — identical to the upload flow.
    """
    match_id = (payload.match_id or "").strip()
    if not match_id:
        raise HTTPException(400, "match_id is required.")
    _api_key()

    detail = await _faceit_get(f"/matches/{match_id}", allow_404=True)
    if detail is None:
        raise HTTPException(404, "Match not found on FACEIT.")
    demo_urls = detail.get("demo_url") or []
    if not demo_urls:
        raise HTTPException(
            409, "No demo is available for this match (it may have expired on FACEIT)."
        )

    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", match_id)
    tmp = _UPLOAD_DIR / f"{uuid.uuid4().hex}.faceitdl"
    dem_path = _UPLOAD_DIR / f"{uuid.uuid4().hex}_faceit_{safe_id}.dem"
    try:
        await _download_capped(demo_urls, tmp)
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _prepare_dem, tmp, dem_path)
    except BaseException:
        dem_path.unlink(missing_ok=True)
        raise
    finally:
        tmp.unlink(missing_ok=True)

    # Ownership of dem_path passes to the parse pipeline (deletes it when done).
    return await start_parse_job(dem_path, f"faceit_{safe_id}.dem")
