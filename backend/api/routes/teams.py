"""
Team analysis routes.

Team sessions (multi-demo analysis for a single map/team):
  POST   /team-sessions/validate          – validate demo set without persisting
  POST   /team-sessions                   – create a team session
  GET    /team-sessions                   – list all sessions
  GET    /team-sessions/{session_id}      – full session detail
  DELETE /team-sessions/{session_id}      – delete a session
  POST   /team-sessions/{session_id}/heatmap

Team organizer (group demos by team across maps):
  GET    /teams                           – list teams
  POST   /teams                           – create a team
  GET    /teams/{team_id}                 – team detail with per-map demo list
  DELETE /teams/{team_id}                 – delete a team
  POST   /teams/{team_id}/demos           – add demos to a team
  DELETE /teams/{team_id}/demos/{demo_id} – remove a demo from a team
"""

from __future__ import annotations

import datetime
import json
import logging
import uuid
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from analytics.coordinates import get_calibration_or_raise
from analytics.heatmap import HeatmapRequest, compute_heatmap, heatmap_to_base64_png
from analytics.team_detection import DemoRoster, detect_team
from db.database import get_connection

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class TeamSessionValidatePayload(BaseModel):
    demo_ids: list[str]


class TeamSessionCreatePayload(BaseModel):
    name:     str
    demo_ids: list[str]


class TeamSessionHeatmapPayload(BaseModel):
    rounds:              list[dict]    # [{"demo_id": str, "round_number": int}]
    player_ids:          list[str]  = []
    layer_label:         Optional[str]  = None
    exclude_freeze_time: bool           = True
    team_filter:         Optional[str]  = None  # "team" | "opponent" | None
    sample_every:        int            = 1
    blur_sigma:          float          = 3.0


class TeamCreatePayload(BaseModel):
    name: str


class TeamAddDemosPayload(BaseModel):
    demo_ids: list[str]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

async def _gather_rosters(demo_ids: list[str]) -> list[DemoRoster]:
    """Build DemoRoster objects for the given demo_ids by querying the DB."""
    if not demo_ids:
        return []

    ph = ",".join("?" * len(demo_ids))
    async with get_connection() as conn:
        cur = await conn.execute(
            f"SELECT id, map_name FROM demos WHERE id IN ({ph})",
            demo_ids,
        )
        demo_map = {row["id"]: row["map_name"] for row in await cur.fetchall()}

        cur = await conn.execute(
            f"SELECT demo_id, player_id, initial_team FROM players "
            f"WHERE demo_id IN ({ph})",
            demo_ids,
        )
        rows = await cur.fetchall()

    sides: dict[str, dict[str, set[int]]] = {
        d: {"CT": set(), "T": set()} for d in demo_ids
    }
    for r in rows:
        side = r["initial_team"]
        if side in ("CT", "T"):
            sides[r["demo_id"]][side].add(int(r["player_id"]))

    return [
        DemoRoster(
            demo_id=d,
            map_name=demo_map[d],
            ct=sides[d]["CT"],
            t=sides[d]["T"],
        )
        for d in demo_ids
        if d in demo_map
    ]


async def _enrich_validation(detection, demo_ids: list[str]) -> dict:
    """Attach per-demo file info and roster names to a detection result."""
    out: dict = {
        "ok":              detection.ok,
        "error":           detection.error,
        "map_name":        detection.map_name,
        "team_sides":      detection.team_sides,
        "core_roster":     [str(sid) for sid in detection.core_roster],
        "extended_roster": [str(sid) for sid in detection.extended_roster],
        "demos":           [],
        "roster_names":    {},
    }

    if not demo_ids:
        return out

    ph = ",".join("?" * len(demo_ids))
    async with get_connection() as conn:
        cur = await conn.execute(
            f"SELECT id, filename, map_name, parsed_at, file_size FROM demos "
            f"WHERE id IN ({ph})",
            demo_ids,
        )
        for row in await cur.fetchall():
            out["demos"].append({
                "demo_id":   row["id"],
                "filename":  row["filename"],
                "map_name":  row["map_name"],
                "parsed_at": row["parsed_at"],
                "file_size": row["file_size"],
            })

        all_sids = detection.core_roster + [
            sid for sid in detection.extended_roster
            if sid not in detection.core_roster
        ]
        if all_sids:
            sid_ph = ",".join("?" * len(all_sids))
            cur = await conn.execute(
                f"SELECT player_id, name FROM players "
                f"WHERE player_id IN ({sid_ph}) GROUP BY player_id",
                all_sids,
            )
            for row in await cur.fetchall():
                out["roster_names"][str(row["player_id"])] = row["name"]

    return out


def _dedup_ordered(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in ids:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


# ---------------------------------------------------------------------------
# Team session endpoints
# ---------------------------------------------------------------------------

@router.post("/team-sessions/validate")
async def validate_team_session(payload: TeamSessionValidatePayload) -> dict:
    """
    Check whether a set of demos forms a valid team session.

    Returns the detected team roster, the side each demo was played on, and
    per-demo metadata.  Does not persist anything.
    """
    if len(payload.demo_ids) < 2:
        raise HTTPException(422, "Need at least 2 demos to form a team session")
    if len(payload.demo_ids) > 20:
        raise HTTPException(422, "Maximum 20 demos per team session")

    demo_ids = _dedup_ordered(payload.demo_ids)
    rosters  = await _gather_rosters(demo_ids)

    if len(rosters) != len(demo_ids):
        found   = {r.demo_id for r in rosters}
        missing = [d for d in demo_ids if d not in found]
        raise HTTPException(404, f"Demo(s) not found: {', '.join(missing[:3])}")

    detection = detect_team(rosters)
    return await _enrich_validation(detection, demo_ids)


@router.post("/team-sessions")
async def create_team_session(payload: TeamSessionCreatePayload) -> dict:
    """Validate the demo set, persist it as a team session, and return its id."""
    if not payload.name.strip():
        raise HTTPException(422, "Session name must not be empty")
    if len(payload.demo_ids) < 2:
        raise HTTPException(422, "Need at least 2 demos to form a team session")

    demo_ids = _dedup_ordered(payload.demo_ids)
    rosters  = await _gather_rosters(demo_ids)

    if len(rosters) != len(demo_ids):
        raise HTTPException(404, "One or more demos no longer exist")

    detection = detect_team(rosters)
    if not detection.ok:
        raise HTTPException(422, detection.error or "Team detection failed")

    session_id = uuid.uuid4().hex
    created_at = datetime.datetime.utcnow().isoformat() + "Z"

    async with get_connection() as conn:
        await conn.execute(
            """INSERT INTO team_sessions
               (id, name, map_name, demo_ids_json, team_sides_json,
                core_roster_json, extended_roster_json, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                session_id,
                payload.name.strip(),
                detection.map_name,
                json.dumps(demo_ids),
                json.dumps(detection.team_sides),
                json.dumps([str(s) for s in detection.core_roster]),
                json.dumps([str(s) for s in detection.extended_roster]),
                created_at,
            ),
        )
        await conn.commit()

    return {"id": session_id, "name": payload.name.strip(), "created_at": created_at}


@router.get("/team-sessions")
async def list_team_sessions() -> list[dict]:
    """List all team sessions (lightweight summary)."""
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT id, name, map_name, demo_ids_json, created_at "
            "FROM team_sessions ORDER BY created_at DESC"
        )
        rows = await cur.fetchall()

    return [
        {
            "id":         r["id"],
            "name":       r["name"],
            "map_name":   r["map_name"],
            "demo_count": len(json.loads(r["demo_ids_json"])),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@router.get("/team-sessions/{session_id}")
async def get_team_session(session_id: str) -> dict:
    """Return full session details: demos, rounds, roster, sides."""
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM team_sessions WHERE id = ?", (session_id,)
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Team session not found")

        demo_ids        = json.loads(row["demo_ids_json"])
        team_sides      = json.loads(row["team_sides_json"])
        core_roster     = json.loads(row["core_roster_json"])
        extended_roster = json.loads(row["extended_roster_json"])

        if not demo_ids:
            return {"id": session_id, "rounds": [], "demos": []}

        ph = ",".join("?" * len(demo_ids))
        cur = await conn.execute(
            f"SELECT id, filename, map_name, tick_rate, total_ticks, parsed_at, file_size "
            f"FROM demos WHERE id IN ({ph})",
            demo_ids,
        )
        demos = [dict(r) for r in await cur.fetchall()]

        cur = await conn.execute(
            f"SELECT * FROM rounds WHERE demo_id IN ({ph}) "
            f"ORDER BY demo_id, round_number",
            demo_ids,
        )
        rounds_rows = [dict(r) for r in await cur.fetchall()]

        all_sids = list({int(s) for s in core_roster + extended_roster})
        roster_names: dict[str, str] = {}
        if all_sids:
            sid_ph = ",".join("?" * len(all_sids))
            cur = await conn.execute(
                f"SELECT player_id, name FROM players "
                f"WHERE player_id IN ({sid_ph}) GROUP BY player_id",
                all_sids,
            )
            for r in await cur.fetchall():
                roster_names[str(r["player_id"])] = r["name"]

    demo_order  = {d: i for i, d in enumerate(demo_ids)}
    demos.sort(key=lambda d: demo_order.get(d["id"], 9999))
    rounds_rows.sort(
        key=lambda r: (demo_order.get(r["demo_id"], 9999), r["round_number"])
    )

    return {
        "id":              row["id"],
        "name":            row["name"],
        "map_name":        row["map_name"],
        "created_at":      row["created_at"],
        "demo_ids":        demo_ids,
        "team_sides":      team_sides,
        "core_roster":     core_roster,
        "extended_roster": extended_roster,
        "roster_names":    roster_names,
        "demos":           demos,
        "rounds":          rounds_rows,
    }


@router.delete("/team-sessions/{session_id}")
async def delete_team_session(session_id: str):
    async with get_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM team_sessions WHERE id = ?", (session_id,)
        )
        await conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Team session not found")
    return {"deleted": session_id}


@router.post("/team-sessions/{session_id}/heatmap")
async def team_session_heatmap(session_id: str, payload: TeamSessionHeatmapPayload):
    """
    Generate a heatmap aggregating positions across multiple demos.

    team_filter:
      "team"     – restrict to the detected team's side per demo
      "opponent" – restrict to the opposing side per demo
      None       – no team filtering (both sides)
    """
    if not payload.rounds:
        raise HTTPException(422, "rounds must not be empty")
    if len(payload.rounds) > 200:
        raise HTTPException(422, "rounds must contain at most 200 entries")
    if len(payload.player_ids) > 20:
        raise HTTPException(422, "player_ids must contain at most 20 entries")

    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT map_name, team_sides_json FROM team_sessions WHERE id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Team session not found")

    map_name:   str             = row["map_name"]
    team_sides: dict[str, str]  = json.loads(row["team_sides_json"])

    try:
        calibration = get_calibration_or_raise(map_name)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    # Group requested rounds by demo for query batching.
    by_demo: dict[str, list[int]] = {}
    for entry in payload.rounds:
        d  = entry.get("demo_id")
        rn = entry.get("round_number")
        if not isinstance(d, str) or not isinstance(rn, int):
            raise HTTPException(
                422, "Each round entry needs {demo_id: str, round_number: int}"
            )
        if d not in team_sides:
            raise HTTPException(422, f"Demo {d} is not part of this session")
        by_demo.setdefault(d, []).append(rn)

    # Map team_filter → expected team_num per demo.
    # CS2: CT = 3, T = 2; team_sides tells us which side the team played.
    side_to_num = {"CT": 3, "T": 2}
    per_demo_team_filter: dict[str, Optional[int]] = {}
    if payload.team_filter in ("team", "opponent"):
        for d in by_demo:
            team_side = team_sides[d]
            opp_side  = "T" if team_side == "CT" else "CT"
            chosen    = team_side if payload.team_filter == "team" else opp_side
            per_demo_team_filter[d] = side_to_num[chosen]
    else:
        per_demo_team_filter = {d: None for d in by_demo}

    # Validate player_ids (sent as SteamID64 strings to preserve precision).
    steam_ids: list[int] = []
    for sid_str in payload.player_ids:
        try:
            steam_ids.append(int(sid_str))
        except (TypeError, ValueError):
            raise HTTPException(422, f"Invalid player_id: {sid_str!r}")

    # Fetch positions per demo and accumulate into one list.
    all_rows: list = []
    async with get_connection() as conn:
        for demo_id, rounds in by_demo.items():
            round_ph = ",".join("?" * len(rounds))
            conds    = ["pp.demo_id = ?", f"pp.round_number IN ({round_ph})"]
            qp: list = [demo_id, *rounds]

            tn = per_demo_team_filter.get(demo_id)
            if tn is not None:
                conds.append("pp.team_num = ?")
                qp.append(tn)

            if steam_ids:
                sid_ph = ",".join("?" * len(steam_ids))
                conds.append(f"pp.player_id IN ({sid_ph})")
                qp.extend(steam_ids)

            if payload.exclude_freeze_time:
                query = (
                    "SELECT pp.tick, pp.round_number, pp.player_id, "
                    "       pp.x, pp.y, pp.z, pp.team_num "
                    "FROM player_positions pp "
                    "JOIN rounds r ON r.demo_id = pp.demo_id "
                    "             AND r.round_number = pp.round_number "
                    f"WHERE {' AND '.join(conds)} AND pp.tick >= r.freeze_end_tick"
                )
            else:
                query = (
                    "SELECT pp.tick, pp.round_number, pp.player_id, "
                    "       pp.x, pp.y, pp.z, pp.team_num "
                    f"FROM player_positions pp WHERE {' AND '.join(conds)}"
                )

            cur = await conn.execute(query, qp)
            for r in await cur.fetchall():
                all_rows.append((
                    r["tick"], r["round_number"], r["player_id"],
                    r["x"], r["y"], r["z"], r["team_num"],
                ))

    logger.info(
        "team_session_heatmap: session=%s demos=%d rounds=%d players=%d → sql_rows=%d",
        session_id, len(by_demo),
        sum(len(rs) for rs in by_demo.values()),
        len(steam_ids), len(all_rows),
    )

    if not all_rows:
        raise HTTPException(404, "No position data found for the given filters")

    positions_np = np.array(all_rows, dtype=np.float64)

    request = HeatmapRequest(
        player_ids=[],     # SQL pre-filtered; float64 is unsafe for SteamID64s
        round_numbers=[],  # SQL pre-filtered; data is cross-demo so scoping is done above
        map_name=map_name,
        layer_label=payload.layer_label,
        exclude_freeze_time=payload.exclude_freeze_time,
        team_filter=None,  # handled per-demo above
        sample_every=payload.sample_every,
        blur_sigma=payload.blur_sigma,
    )

    result  = compute_heatmap(positions_np, request, calibration)
    png_b64 = heatmap_to_base64_png(result)

    return {
        "image":        f"data:image/png;base64,{png_b64}",
        "sample_count": result.sample_count,
        "layer_label":  result.layer_label,
    }


# ---------------------------------------------------------------------------
# Team organizer endpoints
# ---------------------------------------------------------------------------

@router.get("/teams")
async def list_teams_org() -> list[dict]:
    """List all teams with demo counts."""
    async with get_connection() as conn:
        cur = await conn.execute(
            """SELECT t.id, t.name, t.created_at, COUNT(r.id) AS demo_count
               FROM teams t
               LEFT JOIN team_demo_refs r ON r.team_id = t.id
               GROUP BY t.id
               ORDER BY t.created_at DESC"""
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/teams")
async def create_team_org(payload: TeamCreatePayload) -> dict:
    """Create a named team container."""
    if not payload.name.strip():
        raise HTTPException(422, "Team name cannot be empty")

    team_id    = str(uuid.uuid4())
    created_at = datetime.datetime.utcnow().isoformat() + "Z"
    async with get_connection() as conn:
        await conn.execute(
            "INSERT INTO teams (id, name, created_at) VALUES (?,?,?)",
            (team_id, payload.name.strip(), created_at),
        )
        await conn.commit()
    return {
        "id":         team_id,
        "name":       payload.name.strip(),
        "created_at": created_at,
        "demo_count": 0,
    }


@router.get("/teams/{team_id}")
async def get_team_org(team_id: str) -> dict:
    """Return team detail with demos grouped by map."""
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT id, name, created_at FROM teams WHERE id = ?", (team_id,)
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Team not found")

        cur = await conn.execute(
            """SELECT d.id, d.filename, d.map_name, d.tick_rate, d.total_ticks,
                      d.parsed_at, d.file_size
               FROM team_demo_refs r
               JOIN demos d ON d.id = r.demo_id
               WHERE r.team_id = ?
               ORDER BY d.map_name, r.added_at""",
            (team_id,),
        )
        demos = [dict(dr) for dr in await cur.fetchall()]

    maps_dict: dict[str, list] = {}
    for d in demos:
        maps_dict.setdefault(d["map_name"], []).append(d)

    return {
        "id":         row["id"],
        "name":       row["name"],
        "created_at": row["created_at"],
        "maps": [
            {"map_name": mn, "demos": demo_list}
            for mn, demo_list in sorted(maps_dict.items())
        ],
    }


@router.delete("/teams/{team_id}")
async def delete_team_org(team_id: str):
    """Delete a team (the demos themselves are not removed)."""
    async with get_connection() as conn:
        cur = await conn.execute("DELETE FROM teams WHERE id = ?", (team_id,))
        await conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Team not found")
    return {"deleted": team_id}


@router.post("/teams/{team_id}/demos")
async def add_demos_to_team(team_id: str, payload: TeamAddDemosPayload) -> dict:
    """Add one or more demos to a team."""
    added_at = datetime.datetime.utcnow().isoformat() + "Z"
    async with get_connection() as conn:
        cur = await conn.execute("SELECT id FROM teams WHERE id = ?", (team_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "Team not found")

        for demo_id in payload.demo_ids:
            try:
                await conn.execute(
                    "INSERT OR IGNORE INTO team_demo_refs (team_id, demo_id, added_at) "
                    "VALUES (?,?,?)",
                    (team_id, demo_id, added_at),
                )
            except Exception:
                pass
        await conn.commit()
    return {"added": len(payload.demo_ids)}


@router.delete("/teams/{team_id}/demos/{demo_id}")
async def remove_demo_from_team(team_id: str, demo_id: str):
    """Remove a demo from a team (the demo stays in the library)."""
    async with get_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM team_demo_refs WHERE team_id = ? AND demo_id = ?",
            (team_id, demo_id),
        )
        await conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Demo not in team")
    return {"removed": demo_id}
