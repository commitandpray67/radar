"""
FastAPI route definitions for the CS2 Radar backend.

Endpoints
---------
POST /api/demos/upload          – upload and parse a .dem file
GET  /api/demos                 – list cached demos
GET  /api/demos/{demo_id}       – demo metadata
GET  /api/demos/{demo_id}/rounds
GET  /api/demos/{demo_id}/players
GET  /api/demos/{demo_id}/positions
GET  /api/demos/{demo_id}/events
POST /api/demos/{demo_id}/heatmap
GET  /api/maps                  – list all maps with calibration info
GET  /api/parse-status/{job_id} – SSE stream for parse progress
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import uuid
from pathlib import Path
from typing import Optional, AsyncIterator

# Persistent job→demo mapping so we can recover after a server restart.
_JOB_MAP_FILE = Path("/tmp/cs2radar_job_map.json")


def _persist_job_mapping(job_id: str, demo_id: str) -> None:
    """Write job_id→demo_id to disk so parse-status can survive restarts."""
    try:
        data: dict = {}
        if _JOB_MAP_FILE.exists():
            try:
                data = json.loads(_JOB_MAP_FILE.read_text())
            except Exception:
                data = {}
        data[job_id] = demo_id
        _JOB_MAP_FILE.write_text(json.dumps(data))
    except Exception:
        pass  # non-fatal


def _load_job_demo_id(job_id: str) -> Optional[str]:
    """Look up demo_id for a job_id from the persistent mapping file."""
    try:
        if _JOB_MAP_FILE.exists():
            data = json.loads(_JOB_MAP_FILE.read_text())
            return data.get(job_id)
    except Exception:
        pass
    return None

import numpy as np
from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from db.database import (
    demo_exists, file_hash, get_connection, init_db, store_demo
)
from maps.calibration import MAP_CALIBRATIONS, get_calibration
from analytics.coordinates import get_calibration_or_raise
from analytics.heatmap import HeatmapRequest, compute_heatmap, heatmap_to_base64_png

logger = logging.getLogger(__name__)
router = APIRouter()

# Directory where uploaded demo files are kept for voice extraction
_DEMO_STORE = Path("/tmp/cs2radar_demos")
_VOICE_CACHE = Path("/tmp/cs2radar_voice")


def _demo_file_path(demo_id: str) -> Path:
    """Persistent location for a demo file (kept after parse for voice extraction)."""
    return _DEMO_STORE / f"{demo_id}.dem"


def _voice_dir(demo_id: str, round_number: int) -> Path:
    """Cache directory for voice WAV files for one round."""
    return _VOICE_CACHE / demo_id / str(round_number)


def _sanitize_nan(obj):
    """Recursively replace NaN/Inf floats with None (→ JSON null) for JSON safety.
    Using None rather than 0 prevents coordinates like (0,0) appearing on the map."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nan(v) for v in obj]
    return obj

# In-memory parse job status store
_parse_jobs: dict[str, dict] = {}

# Per-demo-id lock: prevents concurrent parses of the same file
_parse_locks: dict[str, asyncio.Lock] = {}
_parse_locks_mu = asyncio.Lock()


async def _get_parse_lock(demo_id: str) -> asyncio.Lock:
    async with _parse_locks_mu:
        if demo_id not in _parse_locks:
            _parse_locks[demo_id] = asyncio.Lock()
        return _parse_locks[demo_id]


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@router.get("/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class HeatmapPayload(BaseModel):
    player_ids: list[int]
    round_numbers: list[int]
    layer_label: Optional[str] = None
    exclude_freeze_time: bool = True
    team_filter: Optional[str] = None
    sample_every: int = 1
    blur_sigma: float = 3.0


# ---------------------------------------------------------------------------
# Map metadata
# ---------------------------------------------------------------------------

@router.get("/maps")
async def list_maps():
    """Return all known maps with their calibration metadata."""
    result = []
    import math

    def _json_float(v: float) -> float | None:
        """Convert ±inf to None for JSON compatibility."""
        if math.isinf(v):
            return None
        return v

    for name, cal in MAP_CALIBRATIONS.items():
        entry = {
            "name": name,
            "is_multilevel": cal.is_multilevel,
            "layers": (
                [{"label": la.label, "image": la.image,
                  "z_min": _json_float(la.z_min), "z_max": _json_float(la.z_max)}
                 for la in cal.layers]
                if cal.is_multilevel
                else []
            ),
            "image": cal.image if not cal.is_multilevel else "",
        }
        result.append(entry)
    return result


# ---------------------------------------------------------------------------
# Demo upload & parse
# ---------------------------------------------------------------------------

@router.post("/demos/upload")
async def upload_demo(
    file: UploadFile = File(...),
    force: bool = False,   # ?force=true skips the cache → always re-parses
):
    """
    Accept a .dem file upload, hash it, and start async parsing.
    Returns a job_id the client can poll via /parse-status/{job_id}.
    Pass ?force=true to re-parse a previously cached demo.
    """
    if not file.filename or not file.filename.lower().endswith(".dem"):
        raise HTTPException(400, "File must be a .dem demo file")

    # Write upload to temp dir
    tmp_dir = Path("/tmp/cs2radar_uploads")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{uuid.uuid4().hex}_{file.filename}"

    content = await file.read()
    tmp_path.write_bytes(content)

    demo_id = file_hash(tmp_path)
    job_id = str(uuid.uuid4())

    _parse_jobs[job_id] = {
        "status": "pending",
        "progress": 0.0,
        "message": "Queued",
        "demo_id": demo_id,
        "filename": file.filename,
    }

    # Check cache (skipped when force=True).
    # Re-parse when: (a) parser version changed, or (b) no winner data.
    if not force and await demo_exists(demo_id):
        from parser.demo_parser import PARSER_VERSION
        import json as _json

        cache_valid = False
        cached_version = 0
        async with get_connection() as conn:
            # Single query: grab parser version from meta AND winner-round count
            cur = await conn.execute(
                """SELECT d.meta_json,
                          COUNT(r.id) AS round_count
                   FROM demos d
                   LEFT JOIN rounds r
                          ON r.demo_id = d.id AND r.winner_team != ''
                   WHERE d.id = ?
                   GROUP BY d.id""",
                (demo_id,),
            )
            row = await cur.fetchone()
            if row:
                meta = _json.loads(row["meta_json"] or "{}")
                cached_version = meta.get("parser_version", 0)
                cache_valid = (cached_version == PARSER_VERSION and row["round_count"] > 0)

        if cache_valid:
            _parse_jobs[job_id] = {
                "status": "complete",
                "progress": 1.0,
                "message": "Loaded from cache",
                "demo_id": demo_id,
                "filename": file.filename,
            }
            tmp_path.unlink(missing_ok=True)
            return {"job_id": job_id, "demo_id": demo_id, "cached": True}

        logger.info(
            "Re-parsing demo %s (cached v%d, current v%d)",
            demo_id, cached_version, PARSER_VERSION,
        )

    # Persist job→demo mapping so parse-status survives a server restart
    _persist_job_mapping(job_id, demo_id)

    # Start background parse (pass file size so it can be stored)
    file_size = tmp_path.stat().st_size
    lock = await _get_parse_lock(demo_id)
    asyncio.create_task(_parse_task(job_id, demo_id, tmp_path, file.filename, file_size, lock))

    return {"job_id": job_id, "demo_id": demo_id, "cached": False}


async def _parse_task(
    job_id: str,
    demo_id: str,
    tmp_path: Path,
    filename: str,
    file_size: int = 0,
    lock: asyncio.Lock | None = None,
) -> None:
    """Background task: parse demo and store results."""
    import concurrent.futures

    def _progress(frac: float, msg: str) -> None:
        _parse_jobs[job_id]["progress"] = frac
        _parse_jobs[job_id]["message"] = msg
        _parse_jobs[job_id]["status"] = "running"

    async def _run():
        try:
            _progress(0.0, "Starting parse")

            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                from parser.demo_parser import parse_demo
                parsed = await loop.run_in_executor(
                    pool,
                    lambda: parse_demo(str(tmp_path), progress_callback=_progress),
                )

            _progress(0.95, "Storing to database")
            await store_demo(parsed, demo_id, filename, file_size=file_size)

            # Keep the demo file for on-demand voice extraction
            _DEMO_STORE.mkdir(parents=True, exist_ok=True)
            dest = _demo_file_path(demo_id)
            if not dest.exists():
                import shutil
                shutil.copy2(tmp_path, dest)
                logger.info("Demo file stored at %s for voice extraction", dest)

            _parse_jobs[job_id] = {
                "status": "complete",
                "progress": 1.0,
                "message": "Done",
                "demo_id": demo_id,
                "filename": filename,
                "map_name": parsed.match_info.map_name,
            }
        except MemoryError:
            logger.exception("Parse OOM for job %s", job_id)
            _parse_jobs[job_id] = {
                "status": "error",
                "progress": 0.0,
                "message": "Parse failed — demo file is too large (out of memory).",
                "demo_id": demo_id,
                "filename": filename,
            }
        except FileNotFoundError:
            logger.exception("Parse file not found for job %s", job_id)
            _parse_jobs[job_id] = {
                "status": "error",
                "progress": 0.0,
                "message": "Parse failed — demo file was not found on disk.",
                "demo_id": demo_id,
                "filename": filename,
            }
        except Exception as exc:
            logger.exception("Parse failed for job %s", job_id)
            exc_str = str(exc).lower()
            if any(w in exc_str for w in ("corrupt", "invalid", "truncat", "eof")):
                msg = "Parse failed — demo file appears to be corrupt or incomplete."
            elif "import" in exc_str or "module" in exc_str:
                msg = "Parse failed — a required server dependency is missing; check server logs."
            else:
                msg = f"Parse failed ({type(exc).__name__}) — see server logs for details."
            _parse_jobs[job_id] = {
                "status": "error",
                "progress": 0.0,
                "message": msg,
                "demo_id": demo_id,
                "filename": filename,
            }
        finally:
            tmp_path.unlink(missing_ok=True)

    if lock is not None:
        async with lock:
            await _run()
    else:
        await _run()


@router.get("/parse-status/{job_id}")
async def parse_status_stream(job_id: str):
    """
    Server-Sent Events stream that pushes parse progress to the client.

    If the job isn't in memory (e.g. server restarted while parsing), we
    check the database: if the demo_id is already stored, report 'complete'
    so the frontend can proceed without re-uploading.
    """
    async def _event_generator() -> AsyncIterator[str]:
        # Allow up to 5 s for the job to appear after a server restart
        for _ in range(10):
            job = _parse_jobs.get(job_id)
            if job is not None:
                break
            await asyncio.sleep(0.5)

        if job is None:
            # Job not in memory — the server likely restarted while parsing.
            # First try the persistent job→demo map for an exact match.
            demo_id_hint = _load_job_demo_id(job_id)
            row = None
            async with get_connection() as conn:
                if demo_id_hint:
                    cursor = await conn.execute(
                        "SELECT id, filename, map_name FROM demos WHERE id = ?",
                        (demo_id_hint,),
                    )
                    row = await cursor.fetchone()
                if row is None:
                    # Fallback: most recently parsed demo (best-effort heuristic)
                    cursor = await conn.execute(
                        "SELECT id, filename, map_name FROM demos ORDER BY parsed_at DESC LIMIT 1"
                    )
                    row = await cursor.fetchone()

            if row:
                synthetic = {
                    "status": "complete",
                    "progress": 1.0,
                    "message": "Loaded from cache (server restarted during parse)",
                    "demo_id": row["id"],
                    "filename": row["filename"],
                    "map_name": row["map_name"],
                }
                yield f"data: {json.dumps(_sanitize_nan(synthetic))}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'error', 'progress': 0, 'message': 'Server restarted and job was lost. Please upload the demo again.', 'demo_id': '', 'filename': ''})}\n\n"
            return

        while True:
            job = _parse_jobs.get(job_id, job)  # keep last known if removed
            yield f"data: {json.dumps(_sanitize_nan(job))}\n\n"
            if job["status"] in ("complete", "error"):
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Demo list / metadata
# ---------------------------------------------------------------------------

@router.get("/demos")
async def list_demos():
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id, filename, map_name, tick_rate, total_ticks, parsed_at, file_size FROM demos"
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.delete("/demos/{demo_id}")
async def delete_demo(demo_id: str):
    """Delete a demo and all associated data from the database."""
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT id FROM demos WHERE id = ?", (demo_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "Demo not found")

        try:
            await conn.execute("BEGIN")
            for table in [
                "player_positions", "events", "rounds", "players",
                "grenades", "player_state_events",
            ]:
                await conn.execute(f"DELETE FROM {table} WHERE demo_id = ?", (demo_id,))
            # demos table uses `id` as primary key, not `demo_id`
            await conn.execute("DELETE FROM demos WHERE id = ?", (demo_id,))
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise
    return {"deleted": demo_id}


@router.get("/demos/{demo_id}")
async def get_demo(demo_id: str):
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT * FROM demos WHERE id = ?", (demo_id,)
        )
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Demo not found")
    return dict(row)


# ---------------------------------------------------------------------------
# Rounds
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/rounds")
async def get_rounds(demo_id: str):
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT * FROM rounds WHERE demo_id = ? ORDER BY round_number",
            (demo_id,),
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Players
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/players")
async def get_players(demo_id: str):
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT * FROM players WHERE demo_id = ?", (demo_id,)
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Positions
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/positions")
async def get_positions(
    demo_id: str,
    round_number: Optional[int] = Query(None),
    player_ids: Optional[str] = Query(None),  # comma-separated SteamIDs
    tick_min: Optional[int] = Query(None),
    tick_max: Optional[int] = Query(None),
):
    """
    Return player positions for a demo, optionally filtered.
    For large demos this may return many rows; use round_number to narrow.
    """
    clauses = ["demo_id = ?"]
    params: list = [demo_id]

    if round_number is not None:
        clauses.append("round_number = ?")
        params.append(round_number)

    if player_ids:
        ids = [int(x.strip()) for x in player_ids.split(",") if x.strip().isdigit()]
        if ids:
            placeholders = ",".join("?" * len(ids))
            clauses.append(f"player_id IN ({placeholders})")
            params.extend(ids)

    if tick_min is not None:
        clauses.append("tick >= ?")
        params.append(tick_min)

    if tick_max is not None:
        clauses.append("tick <= ?")
        params.append(tick_max)

    where = " AND ".join(clauses)

    async with get_connection() as conn:
        cursor = await conn.execute(
            f"SELECT tick, round_number, player_id, x, y, z, team_num, is_alive, yaw "
            f"FROM player_positions WHERE {where} ORDER BY tick, player_id",
            params,
        )
        rows = await cursor.fetchall()

    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/events")
async def get_events(
    demo_id: str,
    round_number: Optional[int] = Query(None),
    event_type: Optional[str] = Query(None),
):
    clauses = ["demo_id = ?"]
    params: list = [demo_id]

    if round_number is not None:
        clauses.append("round_number = ?")
        params.append(round_number)

    if event_type:
        clauses.append("event_type = ?")
        params.append(event_type)

    where = " AND ".join(clauses)

    async with get_connection() as conn:
        cursor = await conn.execute(
            f"SELECT * FROM events WHERE {where} ORDER BY tick",
            params,
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Grenades
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/grenades")
async def get_grenades(
    demo_id: str,
    round_number: Optional[int] = Query(None),
):
    """Return grenade events for a demo, optionally filtered by round."""
    clauses = ["demo_id = ?"]
    params: list = [demo_id]
    if round_number is not None:
        clauses.append("round_number = ?")
        params.append(round_number)
    where = " AND ".join(clauses)
    async with get_connection() as conn:
        cursor = await conn.execute(
            f"SELECT * FROM grenades WHERE {where} ORDER BY throw_tick",
            params,
        )
        rows = await cursor.fetchall()
    import json as _json
    result = []
    for r in rows:
        d = dict(r)
        raw_traj = d.get("trajectory")
        if raw_traj:
            try:
                d["trajectory"] = _json.loads(raw_traj)
            except Exception as _exc:
                logger.warning(
                    "Failed to parse trajectory JSON for grenade id=%s: %s",
                    d.get("id"), _exc,
                )
                d["trajectory"] = None
        else:
            d["trajectory"] = None
        result.append(d)
    return result


# ---------------------------------------------------------------------------
# Player state events
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/player-state-events")
async def get_player_state_events(
    demo_id: str,
    round_number: Optional[int] = Query(None),
    player_ids: Optional[str] = Query(None),  # comma-separated SteamID64s
):
    """Return player state events (HP, armor, weapon equip) for a demo."""
    clauses = ["demo_id = ?"]
    params: list = [demo_id]
    if round_number is not None:
        clauses.append("round_number = ?")
        params.append(round_number)
    if player_ids:
        ids = [int(x.strip()) for x in player_ids.split(",") if x.strip().isdigit()]
        if ids:
            placeholders = ",".join("?" * len(ids))
            clauses.append(f"player_id IN ({placeholders})")
            params.extend(ids)
    where = " AND ".join(clauses)
    async with get_connection() as conn:
        cursor = await conn.execute(
            f"SELECT * FROM player_state_events WHERE {where} ORDER BY tick",
            params,
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Heatmap
# ---------------------------------------------------------------------------

@router.post("/demos/{demo_id}/heatmap")
async def generate_heatmap(demo_id: str, payload: HeatmapPayload):  # noqa: C901
    if len(payload.player_ids) > 20:
        raise HTTPException(422, "player_ids must contain at most 20 entries")
    if len(payload.round_numbers) > 40:
        raise HTTPException(422, "round_numbers must contain at most 40 entries")
    if not payload.round_numbers:
        raise HTTPException(422, "round_numbers must not be empty")
    """
    Generate a heatmap PNG for the given player(s) and rounds.
    Returns a base64-encoded PNG data URL.
    """
    # Fetch demo map name
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT map_name FROM demos WHERE id = ?", (demo_id,)
        )
        demo_row = await cursor.fetchone()
    if not demo_row:
        raise HTTPException(404, "Demo not found")

    map_name: str = demo_row["map_name"]

    try:
        calibration = get_calibration_or_raise(map_name)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    # Resolve DB row IDs → SteamID64s.  The frontend sends small integer DB IDs
    # because SteamID64s exceed JS Number.MAX_SAFE_INTEGER and lose precision
    # when serialised through JSON.
    steam_ids: list = []
    if payload.player_ids:
        id_ph = ",".join("?" * len(payload.player_ids))
        async with get_connection() as conn:
            cursor = await conn.execute(
                f"SELECT player_id FROM players "
                f"WHERE demo_id = ? AND id IN ({id_ph})",
                [demo_id, *payload.player_ids],
            )
            steam_ids = [row["player_id"] for row in await cursor.fetchall()]

    # Build position query.  When excluding freeze time, JOIN with rounds so we
    # can filter pp.tick >= r.freeze_end_tick in a single DB round-trip.
    round_ph = ",".join("?" * len(payload.round_numbers))

    if payload.exclude_freeze_time:
        conds = [
            "pp.demo_id = ?",
            f"pp.round_number IN ({round_ph})",
        ]
        q_params: list = [demo_id, *payload.round_numbers]
        if steam_ids:
            player_ph = ",".join("?" * len(steam_ids))
            conds.append(f"pp.player_id IN ({player_ph})")
            q_params.extend(steam_ids)
        query = (
            "SELECT pp.tick, pp.round_number, pp.player_id, pp.x, pp.y, pp.z, pp.team_num "
            "FROM player_positions pp "
            "JOIN rounds r ON r.demo_id = pp.demo_id AND r.round_number = pp.round_number "
            f"WHERE {' AND '.join(conds)} AND pp.tick >= r.freeze_end_tick"
        )
    else:
        conds = ["demo_id = ?", f"round_number IN ({round_ph})"]
        q_params = [demo_id, *payload.round_numbers]
        if steam_ids:
            player_ph = ",".join("?" * len(steam_ids))
            conds.append(f"player_id IN ({player_ph})")
            q_params.extend(steam_ids)
        query = (
            f"SELECT tick, round_number, player_id, x, y, z, team_num "
            f"FROM player_positions WHERE {' AND '.join(conds)}"
        )

    async with get_connection() as conn:
        cursor = await conn.execute(query, q_params)
        rows = await cursor.fetchall()

    if not rows:
        raise HTTPException(404, "No position data found for the given filters")

    # Convert to numpy: columns [tick, round, player_id, x, y, z, team_num]
    positions_np = np.array(
        [[r["tick"], r["round_number"], r["player_id"], r["x"], r["y"], r["z"], r["team_num"]]
         for r in rows],
        dtype=np.float64,
    )

    request = HeatmapRequest(
        player_ids=[],    # SQL pre-filtered; skip float64-imprecise Python re-filter
        round_numbers=payload.round_numbers,
        map_name=map_name,
        layer_label=payload.layer_label,
        exclude_freeze_time=payload.exclude_freeze_time,
        team_filter=payload.team_filter,
        sample_every=payload.sample_every,
        blur_sigma=payload.blur_sigma,
    )

    result = compute_heatmap(positions_np, request, calibration)
    png_b64 = heatmap_to_base64_png(result)

    return {
        "image": f"data:image/png;base64,{png_b64}",
        "sample_count": result.sample_count,
        "layer_label": result.layer_label,
    }


# ---------------------------------------------------------------------------
# Voice lines
# ---------------------------------------------------------------------------

@router.get("/demos/{demo_id}/voice")
async def get_voice_manifest(
    demo_id: str,
    round_number: int = Query(...),
):
    """
    Return a voice manifest for a specific round.

    Extraction is lazy: OGG Opus clips are generated on first request and
    cached for subsequent requests.  Returns available=False when the demo
    has no voice data or the demo file is no longer on disk.
    """
    # Fetch demo metadata
    async with get_connection() as conn:
        cursor = await conn.execute(
            "SELECT tick_rate FROM demos WHERE id = ?", (demo_id,)
        )
        demo_row = await cursor.fetchone()
        if not demo_row:
            raise HTTPException(404, "Demo not found")

        cursor = await conn.execute(
            "SELECT start_tick, end_tick FROM rounds "
            "WHERE demo_id = ? AND round_number = ?",
            (demo_id, round_number),
        )
        round_row = await cursor.fetchone()
        if not round_row:
            raise HTTPException(404, "Round not found")

        cursor = await conn.execute(
            "SELECT player_id, name FROM players WHERE demo_id = ?",
            (demo_id,),
        )
        player_rows = await cursor.fetchall()

    tick_rate: float = demo_row["tick_rate"] or 64.0
    start_tick: int = round_row["start_tick"]
    end_tick: int   = round_row["end_tick"]

    # Build steamid→name map
    name_map: dict[int, str] = {r["player_id"]: r["name"] for r in player_rows}

    # Check if demo file is available
    demo_path = _demo_file_path(demo_id)
    if not demo_path.exists():
        logger.warning(
            "Demo file not found for voice extraction: %s — "
            "file is only available if the demo was parsed in this server session.",
            demo_path,
        )
        return {
            "round_number": round_number,
            "start_tick": start_tick,
            "end_tick": end_tick,
            "tick_rate": tick_rate,
            "available": False,
            "players": [],
        }

    # Extract voice clips (cached per demo/round)
    voice_dir = _voice_dir(demo_id, round_number)
    import asyncio as _aio

    loop = _aio.get_event_loop()
    from voice.extractor import extract_voice_for_round  # noqa: PLC0415

    try:
        clip_map: dict = await loop.run_in_executor(
            None,
            lambda: extract_voice_for_round(
                str(demo_path), start_tick, end_tick, tick_rate, voice_dir,
            ),
        )
    except Exception as exc:
        logger.error(
            "Voice extraction failed for demo %s round %d: %s",
            demo_id, round_number, exc,
        )
        return {
            "round_number": round_number,
            "start_tick": start_tick,
            "end_tick": end_tick,
            "tick_rate": tick_rate,
            "available": False,
            "players": [],
        }

    players = []
    for steamid, clip_list in clip_map.items():
        clips = [
            {
                "start_tick": clip_start_tick,
                "audio_url": f"/api/demos/{demo_id}/voice/{round_number}/{steamid}_{clip_idx}.ogg",
            }
            for clip_idx, (clip_start_tick, _) in enumerate(clip_list)
        ]
        players.append({
            "steamid": steamid,
            "name": name_map.get(steamid, str(steamid)),
            "clips": clips,
        })

    return {
        "round_number": round_number,
        "start_tick": start_tick,
        "end_tick": end_tick,
        "tick_rate": tick_rate,
        "available": bool(players),
        "players": players,
    }


@router.get("/demos/{demo_id}/voice/{round_number}/{filename}.ogg")
async def get_voice_audio(demo_id: str, round_number: int, filename: str):
    """Serve a cached per-player OGG Opus clip for a specific round."""
    import re
    if not re.fullmatch(r"\d+_\d+", filename):
        raise HTTPException(400, "Invalid audio filename")
    ogg_path = _voice_dir(demo_id, round_number) / f"{filename}.ogg"
    if not ogg_path.exists():
        raise HTTPException(404, "Voice audio not found — request the manifest first")
    return FileResponse(
        ogg_path,
        media_type="audio/ogg",
        headers={"Cache-Control": "public, max-age=3600"},
    )
