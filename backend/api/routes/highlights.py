"""
Cross-demo player highlight search.

  POST /highlights              – one player's multi-kill rounds (optionally
                                  weapon-filtered) across a set of parsed demos
  GET  /highlights/player-names – distinct player names in the library, for
                                  autocomplete before demos are uploaded

The player is given as a name (case-insensitive, matched per demo against the
stored roster) or a SteamID64, so it can be chosen before the demos it should
be looked up in have been parsed.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from analytics.highlights import find_highlights, normalize_weapon
from db.database import fetch_round_sides, get_connection

logger = logging.getLogger(__name__)
router = APIRouter()


class HighlightsPayload(BaseModel):
    demo_ids: list[str] = Field(min_length=1, max_length=200)
    player: str = Field(min_length=1, max_length=64)
    weapons: list[str] = []  # empty → any weapon
    min_kills: int = Field(default=3, ge=1, le=5)


def _is_steamid(s: str) -> bool:
    return s.isdigit() and len(s) >= 15


@router.post("/highlights")
async def search_highlights(payload: HighlightsPayload):
    query = payload.player.strip()
    if not query:
        raise HTTPException(400, "player must not be blank")
    wanted = {normalize_weapon(w) for w in payload.weapons if w.strip()} or None

    results: list[dict] = []
    async with get_connection() as conn:
        for demo_id in dict.fromkeys(payload.demo_ids):  # dedupe, keep order
            cur = await conn.execute(
                "SELECT id, filename, map_name, tick_rate FROM demos WHERE id = ?",
                (demo_id,),
            )
            demo = await cur.fetchone()
            if not demo:
                results.append({"demo_id": demo_id, "error": "Demo not found", "highlights": []})
                continue

            cur = await conn.execute(
                "SELECT player_id, name FROM players WHERE demo_id = ?", (demo_id,)
            )
            roster = [dict(r) for r in await cur.fetchall()]
            names = {p["player_id"]: p["name"] or "" for p in roster}
            if _is_steamid(query):
                matched = [p for p in roster if str(p["player_id"]) == query]
            else:
                q = query.casefold()
                matched = [p for p in roster if (p["name"] or "").strip().casefold() == q]

            entry = {
                "demo_id": demo_id,
                "filename": demo["filename"],
                "map_name": demo["map_name"],
                "tick_rate": demo["tick_rate"] or 64.0,
                "matched_players": [
                    {"player_id": str(p["player_id"]), "name": p["name"]} for p in matched
                ],
                "highlights": [],
            }
            results.append(entry)
            if not matched:
                continue

            cur = await conn.execute(
                "SELECT round_number, is_knife_round, winner_team FROM rounds "
                "WHERE demo_id = ? ORDER BY round_number",
                (demo_id,),
            )
            rounds = [dict(r) for r in await cur.fetchall()]
            cur = await conn.execute(
                "SELECT tick, round_number, attacker_id, victim_id, weapon, headshot "
                "FROM events WHERE demo_id = ? AND event_type = 'player_death' "
                "ORDER BY tick",
                (demo_id,),
            )
            deaths = [dict(r) for r in await cur.fetchall()]
            sides = await fetch_round_sides(conn, demo_id)

            entry["highlights"] = find_highlights(
                rounds,
                deaths,
                sides,
                {p["player_id"] for p in matched},
                names,
                entry["tick_rate"],
                weapons=wanted,
                min_kills=payload.min_kills,
            )

    return {
        "player": query,
        "weapons": sorted(wanted) if wanted else [],
        "min_kills": payload.min_kills,
        "total": sum(len(r["highlights"]) for r in results),
        "demos": results,
    }


@router.get("/highlights/player-names")
async def player_names():
    """Distinct roster names across cached demos, most frequent first."""
    async with get_connection() as conn:
        cur = await conn.execute(
            "SELECT name, COUNT(DISTINCT demo_id) AS demos FROM players "
            "WHERE name IS NOT NULL AND TRIM(name) != '' "
            "GROUP BY name ORDER BY demos DESC, name COLLATE NOCASE LIMIT 500"
        )
        rows = await cur.fetchall()
    return [{"name": r["name"], "demos": r["demos"]} for r in rows]
