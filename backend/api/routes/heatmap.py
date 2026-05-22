"""
Heatmap route for a single demo.

POST /demos/{demo_id}/heatmap
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from analytics.coordinates import get_calibration_or_raise
from analytics.heatmap import HeatmapRequest, compute_heatmap, heatmap_to_base64_png
from db.database import get_connection

logger = logging.getLogger(__name__)
router = APIRouter()


class HeatmapPayload(BaseModel):
    player_ids:           list[int]
    round_numbers:        list[int]
    layer_label:          Optional[str]  = None
    exclude_freeze_time:  bool           = True
    team_filter:          Optional[str]  = None
    sample_every:         int            = 1
    blur_sigma:           float          = 3.0


@router.post("/demos/{demo_id}/heatmap")
async def generate_heatmap(demo_id: str, payload: HeatmapPayload):
    """Generate a heatmap PNG for the given player(s) and rounds.

    Returns a base64-encoded PNG data URL along with sample count and layer
    label so the frontend can display the correct overlay.
    """
    if len(payload.player_ids) > 20:
        raise HTTPException(422, "player_ids must contain at most 20 entries")
    if len(payload.round_numbers) > 40:
        raise HTTPException(422, "round_numbers must contain at most 40 entries")
    if not payload.round_numbers:
        raise HTTPException(422, "round_numbers must not be empty")

    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT map_name FROM demos WHERE id = ?", (demo_id,)
        )
        demo_row = await cur.fetchone()
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
            cur = await conn.execute(
                f"SELECT player_id FROM players "
                f"WHERE demo_id = ? AND id IN ({id_ph})",
                [demo_id, *payload.player_ids],
            )
            steam_ids = [row["player_id"] for row in await cur.fetchall()]

    round_ph = ",".join("?" * len(payload.round_numbers))

    if payload.exclude_freeze_time:
        conds   = ["pp.demo_id = ?", f"pp.round_number IN ({round_ph})"]
        qparams: list = [demo_id, *payload.round_numbers]
        if steam_ids:
            player_ph = ",".join("?" * len(steam_ids))
            conds.append(f"pp.player_id IN ({player_ph})")
            qparams.extend(steam_ids)
        query = (
            "SELECT pp.tick, pp.round_number, pp.player_id, pp.x, pp.y, pp.z, pp.team_num "
            "FROM player_positions pp "
            "JOIN rounds r ON r.demo_id = pp.demo_id AND r.round_number = pp.round_number "
            f"WHERE {' AND '.join(conds)} AND pp.tick >= r.freeze_end_tick"
        )
    else:
        conds   = ["demo_id = ?", f"round_number IN ({round_ph})"]
        qparams = [demo_id, *payload.round_numbers]
        if steam_ids:
            player_ph = ",".join("?" * len(steam_ids))
            conds.append(f"player_id IN ({player_ph})")
            qparams.extend(steam_ids)
        query = (
            f"SELECT tick, round_number, player_id, x, y, z, team_num "
            f"FROM player_positions WHERE {' AND '.join(conds)}"
        )

    async with get_connection() as conn:
        cur  = await conn.execute(query, qparams)
        rows = await cur.fetchall()

    if not rows:
        raise HTTPException(404, "No position data found for the given filters")

    positions_np = np.array(
        [[r["tick"], r["round_number"], r["player_id"], r["x"], r["y"], r["z"], r["team_num"]]
         for r in rows],
        dtype=np.float64,
    )

    request = HeatmapRequest(
        player_ids=[],                        # SQL pre-filtered; skip float64-unsafe re-filter
        round_numbers=payload.round_numbers,
        map_name=map_name,
        layer_label=payload.layer_label,
        exclude_freeze_time=payload.exclude_freeze_time,
        team_filter=payload.team_filter,
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
