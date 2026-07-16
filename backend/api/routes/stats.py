"""
Per-demo analytics endpoints.

  GET /demos/{demo_id}/scoreboard – aggregated per-player stats (K/D, HS%,
      opening duels, trades, multikills, KAST) computed from stored events.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from analytics.scoreboard import compute_scoreboard
from db.database import fetch_round_sides, get_connection

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/demos/{demo_id}/scoreboard")
async def get_scoreboard(demo_id: str):
    """Aggregate a per-player scoreboard for a parsed demo."""
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT tick_rate FROM demos WHERE id = ?", (demo_id,)
        )
        demo_row = await cur.fetchone()
        if not demo_row:
            raise HTTPException(404, "Demo not found")
        tick_rate = demo_row["tick_rate"] or 64.0

        cur = await conn.execute(
            "SELECT round_number, is_knife_round, winner_team FROM rounds "
            "WHERE demo_id = ? ORDER BY round_number",
            (demo_id,),
        )
        rounds = [dict(r) for r in await cur.fetchall()]

        cur = await conn.execute(
            "SELECT player_id, name, initial_team FROM players WHERE demo_id = ?",
            (demo_id,),
        )
        players = [dict(r) for r in await cur.fetchall()]

        cur = await conn.execute(
            "SELECT tick, round_number, attacker_id, victim_id, headshot "
            "FROM events WHERE demo_id = ? AND event_type = 'player_death' "
            "ORDER BY tick",
            (demo_id,),
        )
        deaths = [dict(r) for r in await cur.fetchall()]

        sides = await fetch_round_sides(conn, demo_id)

    scoreboard = compute_scoreboard(rounds, deaths, sides, players, tick_rate)
    return {"players": scoreboard, "tick_rate": tick_rate}
