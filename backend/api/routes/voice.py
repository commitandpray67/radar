"""
Voice audio routes.

GET /demos/{demo_id}/voice                           – manifest with clip URLs
GET /demos/{demo_id}/voice/{round_number}/{filename}.ogg – serve a cached clip
"""

from __future__ import annotations

import asyncio
import logging
import re

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from db.database import get_connection

from ._shared import _demo_file_path, _voice_dir

logger = logging.getLogger(__name__)
router = APIRouter()

# Fallback window (seconds) added past a round's end when it has no following
# round (the final round of the match) and extended playback is requested.
# Comfortably covers mp_round_restart_delay plus a little post-round buffer.
_POST_ROUND_DELAY_S = 12.0


@router.get("/demos/{demo_id}/voice")
async def get_voice_manifest(
    demo_id: str,
    round_number: int = Query(...),
    extended: bool = Query(False),
):
    """
    Return a voice manifest for a specific round.

    Extraction is lazy: OGG Opus clips are generated on first request and
    cached for subsequent calls.  Returns available=False when the demo has
    no voice data or its source file is no longer on disk.

    When ``extended`` is set the extraction window is stretched past round
    end to the next round's start (i.e. through the post-round restart delay)
    so voice communication during that period is not lost.  Extended clips are
    cached separately from the standard round-only clips.
    """
    async with get_connection() as conn:
        cur = await conn.execute("SELECT tick_rate FROM demos WHERE id = ?", (demo_id,))
        demo_row = await cur.fetchone()
        if not demo_row:
            raise HTTPException(404, "Demo not found")

        cur = await conn.execute(
            "SELECT start_tick, end_tick FROM rounds WHERE demo_id = ? AND round_number = ?",
            (demo_id, round_number),
        )
        round_row = await cur.fetchone()
        if not round_row:
            raise HTTPException(404, "Round not found")

        cur = await conn.execute(
            "SELECT player_id, name FROM players WHERE demo_id = ?",
            (demo_id,),
        )
        player_rows = await cur.fetchall()

        next_start_tick: int | None = None
        if extended:
            cur = await conn.execute(
                "SELECT start_tick FROM rounds "
                "WHERE demo_id = ? AND round_number > ? "
                "ORDER BY round_number LIMIT 1",
                (demo_id, round_number),
            )
            next_row = await cur.fetchone()
            if next_row is not None:
                next_start_tick = int(next_row["start_tick"])

    tick_rate: float = demo_row["tick_rate"] or 64.0
    start_tick: int = round_row["start_tick"]
    end_tick: int = round_row["end_tick"]
    name_map: dict[int, str] = {r["player_id"]: r["name"] for r in player_rows}

    # Effective extraction window.  Extended mode reaches into the post-round
    # restart delay: up to the next round's freeze start (where that round's
    # own window begins), or a fixed buffer past end for the final round.
    extract_start = start_tick
    extract_end = end_tick
    if extended:
        if next_start_tick is not None and next_start_tick > end_tick:
            extract_end = next_start_tick
        else:
            extract_end = end_tick + int(_POST_ROUND_DELAY_S * tick_rate)

    empty_response = {
        "round_number": round_number,
        "start_tick": extract_start,
        "end_tick": extract_end,
        "tick_rate": tick_rate,
        "available": False,
        "players": [],
    }

    demo_path = _demo_file_path(demo_id)
    if not demo_path.exists():
        logger.warning(
            "Demo file not found for voice extraction: %s — "
            "file is only available if the demo was parsed in this server session.",
            demo_path,
        )
        return empty_response

    voice_dir = _voice_dir(demo_id, round_number, extended)
    loop = asyncio.get_event_loop()
    from voice.extractor import extract_voice_for_round

    try:
        clip_map: dict = await loop.run_in_executor(
            None,
            lambda: extract_voice_for_round(
                str(demo_path),
                extract_start,
                extract_end,
                tick_rate,
                voice_dir,
            ),
        )
    except Exception as exc:
        logger.error(
            "Voice extraction failed for demo %s round %d: %s",
            demo_id,
            round_number,
            exc,
        )
        return empty_response

    ext_q = "?extended=true" if extended else ""
    players = []
    for steamid, clip_list in clip_map.items():
        clips = [
            {
                "start_tick": clip_start_tick,
                "audio_url": (
                    f"/api/demos/{demo_id}/voice/{round_number}/{steamid}_{clip_idx}.ogg{ext_q}"
                ),
            }
            for clip_idx, (clip_start_tick, _) in enumerate(clip_list)
        ]
        players.append(
            {
                "steamid": steamid,
                "name": name_map.get(steamid, str(steamid)),
                "clips": clips,
            }
        )

    return {
        "round_number": round_number,
        "start_tick": extract_start,
        "end_tick": extract_end,
        "tick_rate": tick_rate,
        "available": bool(players),
        "players": players,
    }


@router.get("/demos/{demo_id}/voice/{round_number}/{filename}.ogg")
async def get_voice_audio(
    demo_id: str,
    round_number: int,
    filename: str,
    extended: bool = Query(False),
):
    """Serve a cached per-player OGG Opus clip for a specific round.

    ``extended`` must match the flag the manifest was requested with so the
    correct cache sub-directory (round-only vs. round+restart-delay) is used.
    """
    # Validate path components to prevent directory traversal.
    # demo_id: 64-char hex SHA-256; round_number: typed int by FastAPI;
    # filename: <steamid>_<clip_idx> pattern.
    if not re.fullmatch(r"[a-f0-9]{64}", demo_id):
        raise HTTPException(400, "Invalid demo ID")
    if round_number < 0:
        raise HTTPException(400, "Invalid round number")
    if not re.fullmatch(r"\d+_\d+", filename):
        raise HTTPException(400, "Invalid audio filename")

    ogg_path = _voice_dir(demo_id, round_number, extended) / f"{filename}.ogg"
    if not ogg_path.exists():
        raise HTTPException(404, "Voice audio not found — request the manifest first")

    return FileResponse(
        ogg_path,
        media_type="audio/ogg",
        headers={"Cache-Control": "public, max-age=3600"},
    )
