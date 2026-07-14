"""
Demo management routes.

Covers:
  POST /demos/upload                          – upload and start async parse
  GET  /parse-status/{job_id}                 – SSE parse-progress stream
  GET  /demos                                 – list cached demos
  GET  /demos/{demo_id}                       – demo metadata
  DELETE /demos/{demo_id}                     – delete demo and all its data
  GET  /demos/{demo_id}/rounds
  GET  /demos/{demo_id}/players
  GET  /demos/{demo_id}/positions
  GET  /demos/{demo_id}/events
  GET  /demos/{demo_id}/grenades
  GET  /demos/{demo_id}/player-state-events
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import shutil
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from db.database import demo_exists, file_hash, get_connection, store_demo

from ._shared import (
    _DEMO_STORE,
    _MAX_UPLOAD_BYTES,
    _UPLOAD_DIR,
    _demo_file_path,
    _get_parse_lock,
    _load_job_demo_id,
    _parse_jobs,
    _parse_locks,
    _parse_locks_mu,
    _persist_job_mapping,
    _sanitize_nan,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Upload & parse
# ---------------------------------------------------------------------------


@router.post("/demos/upload")
async def upload_demo(
    file: UploadFile = File(...),
    force: bool = False,
):
    """
    Accept a .dem file, hash it, and start an async parse.

    Returns a job_id the client polls via /parse-status/{job_id}.
    Pass ?force=true to bypass the cache and always re-parse.
    """
    if not file.filename or not file.filename.lower().endswith(".dem"):
        raise HTTPException(400, "File must be a .dem demo file")

    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = _UPLOAD_DIR / f"{uuid.uuid4().hex}_{file.filename}"

    # Stream to disk in chunks rather than buffering the whole file in memory
    # (could be 500 MB) and enforce the size limit as bytes arrive so we fail
    # fast and never write a partial file beyond the cap.
    bytes_written = 0
    chunk_size = 1024 * 1024  # 1 MB
    try:
        with tmp_path.open("wb") as out:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > _MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413,
                        f"File too large (> {_MAX_UPLOAD_BYTES // 1_000_000} MB). "
                        f"Raise the limit by setting MAX_UPLOAD_MB.",
                    )
                out.write(chunk)
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise

    return await start_parse_job(tmp_path, file.filename, force=force)


async def start_parse_job(dem_path: Path, filename: str, *, force: bool = False) -> dict:
    """Hash a local ``.dem``, seed a parse job, honour the cache, and schedule
    the background parse when needed.

    The caller must have already written ``dem_path`` to disk (any source —
    an upload or a FACEIT download).  On a cache hit the file is removed here;
    otherwise ownership passes to the background ``_parse_task`` which deletes
    it when finished.  Returns ``{job_id, demo_id, cached}``.
    """
    demo_id = file_hash(dem_path)
    job_id = str(uuid.uuid4())

    _parse_jobs[job_id] = {
        "status": "pending",
        "progress": 0.0,
        "message": "Queued",
        "demo_id": demo_id,
        "filename": filename,
    }

    # Cache check (skipped when force=True).
    # Re-parse when: (a) parser version changed, or (b) no winner-round data.
    if not force and await demo_exists(demo_id):
        from parser.demo_parser import PARSER_VERSION

        cache_valid = False
        cached_version = 0
        async with get_connection() as conn:
            cur = await conn.execute(
                """SELECT d.meta_json, COUNT(r.id) AS round_count
                   FROM demos d
                   LEFT JOIN rounds r
                          ON r.demo_id = d.id AND r.winner_team != ''
                   WHERE d.id = ?
                   GROUP BY d.id""",
                (demo_id,),
            )
            row = await cur.fetchone()
            if row:
                meta = json.loads(row["meta_json"] or "{}")
                cached_version = meta.get("parser_version", 0)
                cache_valid = cached_version == PARSER_VERSION and row["round_count"] > 0

        if cache_valid:
            _parse_jobs[job_id] = {
                "status": "complete",
                "progress": 1.0,
                "message": "Loaded from cache",
                "demo_id": demo_id,
                "filename": filename,
            }
            dem_path.unlink(missing_ok=True)
            return {"job_id": job_id, "demo_id": demo_id, "cached": True}

        logger.info(
            "Re-parsing demo %s (cached v%d, current v%d)",
            demo_id,
            cached_version,
            PARSER_VERSION,
        )

    _persist_job_mapping(job_id, demo_id)

    file_size = dem_path.stat().st_size
    lock = await _get_parse_lock(demo_id)
    asyncio.create_task(_parse_task(job_id, demo_id, dem_path, filename, file_size, lock))

    return {"job_id": job_id, "demo_id": demo_id, "cached": False}


async def _parse_task(
    job_id: str,
    demo_id: str,
    tmp_path: Path,
    filename: str,
    file_size: int = 0,
    lock: asyncio.Lock | None = None,
) -> None:
    """Background task: parse demo and store results in the database."""

    def _progress(frac: float, msg: str) -> None:
        _parse_jobs[job_id]["progress"] = frac
        _parse_jobs[job_id]["message"] = msg
        _parse_jobs[job_id]["status"] = "running"

    async def _run() -> None:
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

            # Keep the demo file on disk for on-demand voice extraction.
            _DEMO_STORE.mkdir(parents=True, exist_ok=True)
            dest = _demo_file_path(demo_id)
            if not dest.exists():
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
                msg = "Parse failed — see server logs for details."
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
        async with _parse_locks_mu:
            _parse_locks.pop(demo_id, None)
    else:
        await _run()


# ---------------------------------------------------------------------------
# Parse status SSE stream
# ---------------------------------------------------------------------------


@router.get("/parse-status/{job_id}")
async def parse_status_stream(job_id: str):
    """
    Server-Sent Events stream that pushes parse progress to the client.

    If the job is not in memory (e.g. server restarted mid-parse), we fall
    back to the persistent job→demo map and then the database.  If the demo
    is already stored we report 'complete' so the frontend can proceed.
    """

    async def _event_generator() -> AsyncIterator[str]:
        # Allow up to 5 s for the job entry to appear after a restart.
        for _ in range(10):
            job = _parse_jobs.get(job_id)
            if job is not None:
                break
            await asyncio.sleep(0.5)

        if job is None:
            # Resolve ONLY via the persisted job→demo mapping. We must not guess
            # "the most recent demo" here: that could report a completely
            # unrelated demo as this job's result.
            demo_id_hint = _load_job_demo_id(job_id)
            row = None
            if demo_id_hint:
                async with get_connection() as conn:
                    cur = await conn.execute(
                        "SELECT id, filename, map_name FROM demos WHERE id = ?",
                        (demo_id_hint,),
                    )
                    row = await cur.fetchone()

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
                err = json.dumps(
                    {
                        "status": "error",
                        "progress": 0,
                        "message": "Server restarted and job was lost. Please upload the demo again.",
                        "demo_id": "",
                        "filename": "",
                    }
                )
                yield f"data: {err}\n\n"
            return

        while True:
            job = _parse_jobs.get(job_id, job)
            yield f"data: {json.dumps(_sanitize_nan(job))}\n\n"
            if job is None or job["status"] in ("complete", "error"):
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(
        _event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Demo list / metadata / delete
# ---------------------------------------------------------------------------


@router.get("/demos")
async def list_demos():
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT id, filename, map_name, tick_rate, total_ticks, parsed_at, file_size FROM demos"
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.get("/demos/{demo_id}")
async def get_demo(demo_id: str):
    async with get_connection() as conn:
        cur = await conn.execute("SELECT * FROM demos WHERE id = ?", (demo_id,))
        row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Demo not found")
    return dict(row)


@router.delete("/demos/{demo_id}")
async def delete_demo(demo_id: str):
    """Delete a demo and all its associated data from the database."""
    async with get_connection() as conn:
        cur = await conn.execute("SELECT id FROM demos WHERE id = ?", (demo_id,))
        if not await cur.fetchone():
            raise HTTPException(404, "Demo not found")

        try:
            await conn.execute("BEGIN")
            for table in (
                "player_positions",
                "events",
                "rounds",
                "players",
                "grenades",
                "player_state_events",
                "team_demo_refs",
            ):
                await conn.execute(f"DELETE FROM {table} WHERE demo_id = ?", (demo_id,))
            await conn.execute("DELETE FROM demos WHERE id = ?", (demo_id,))
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise

    return {"deleted": demo_id}


# ---------------------------------------------------------------------------
# Rounds
# ---------------------------------------------------------------------------


@router.get("/demos/{demo_id}/rounds")
async def get_rounds(demo_id: str):
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM rounds WHERE demo_id = ? ORDER BY round_number",
            (demo_id,),
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Players
# ---------------------------------------------------------------------------


@router.get("/demos/{demo_id}/players")
async def get_players(demo_id: str):
    async with get_connection() as conn:
        cur = await conn.execute("SELECT * FROM players WHERE demo_id = ?", (demo_id,))
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Positions
# ---------------------------------------------------------------------------


@router.get("/demos/{demo_id}/positions")
async def get_positions(
    demo_id: str,
    round_number: int | None = Query(None),
    player_ids: str | None = Query(None),  # comma-separated SteamID64s
    tick_min: int | None = Query(None),
    tick_max: int | None = Query(None),
):
    """
    Return player positions, optionally filtered by round, player, and tick range.

    For large demos use round_number to keep the response size manageable.
    """
    clauses: list[str] = ["demo_id = ?"]
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
        cur = await conn.execute(
            f"SELECT tick, round_number, player_id, x, y, z, team_num, is_alive, yaw "
            f"FROM player_positions WHERE {where} ORDER BY tick, player_id",
            params,
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


@router.get("/demos/{demo_id}/events")
async def get_events(
    demo_id: str,
    round_number: int | None = Query(None),
    event_type: str | None = Query(None),
):
    clauses: list[str] = ["demo_id = ?"]
    params: list = [demo_id]

    if round_number is not None:
        clauses.append("round_number = ?")
        params.append(round_number)

    if event_type:
        clauses.append("event_type = ?")
        params.append(event_type)

    where = " AND ".join(clauses)
    async with get_connection() as conn:
        cur = await conn.execute(
            f"SELECT * FROM events WHERE {where} ORDER BY tick",
            params,
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Grenades
# ---------------------------------------------------------------------------


@router.get("/demos/{demo_id}/grenades")
async def get_grenades(
    demo_id: str,
    round_number: int | None = Query(None),
):
    """Return grenade events for a demo, optionally filtered by round."""
    clauses: list[str] = ["demo_id = ?"]
    params: list = [demo_id]

    if round_number is not None:
        clauses.append("round_number = ?")
        params.append(round_number)

    where = " AND ".join(clauses)
    async with get_connection() as conn:
        cur = await conn.execute(
            f"SELECT * FROM grenades WHERE {where} ORDER BY throw_tick",
            params,
        )
        rows = await cur.fetchall()

    result = []
    for r in rows:
        d = dict(r)
        raw_traj = d.get("trajectory")
        if raw_traj:
            try:
                d["trajectory"] = json.loads(raw_traj)
            except Exception as exc:
                logger.warning(
                    "Failed to parse trajectory JSON for grenade id=%s: %s",
                    d.get("id"),
                    exc,
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
    round_number: int | None = Query(None),
    player_ids: str | None = Query(None),  # comma-separated SteamID64s
):
    """Return player state events (HP, armor, weapon equip) for a demo."""
    clauses: list[str] = ["demo_id = ?"]
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
        cur = await conn.execute(
            f"SELECT * FROM player_state_events WHERE {where} ORDER BY tick",
            params,
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]
