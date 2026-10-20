"""
Cross-demo player highlight search.

  POST /highlights              – one player's multi-kill rounds across a set
                                  of parsed demos, optionally requiring some
                                  of the kills to be with chosen weapons
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

from analytics.highlights import candidate_rounds, find_highlights, normalize_weapon
from db.database import fetch_round_sides, get_connection

logger = logging.getLogger(__name__)
router = APIRouter()


class HighlightsPayload(BaseModel):
    demo_ids: list[str] = Field(min_length=1, max_length=200)
    player: str = Field(min_length=1, max_length=64)
    weapons: list[str] = Field(default=[], max_length=64)  # empty → any weapon
    min_kills: int = Field(default=3, ge=1, le=5)  # round kills, any weapon
    min_weapon_kills: int = Field(default=1, ge=1, le=5)  # of which with `weapons`


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
                "SELECT round_number, is_knife_round, winner_team, start_tick, end_tick "
                "FROM rounds WHERE demo_id = ? ORDER BY round_number",
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
            # Sides are only needed for rounds that can qualify; skipping the
            # rest avoids scanning every position row of every demo.
            all_ids = {p["player_id"] for p in matched}
            cands = candidate_rounds(rounds, deaths, all_ids, payload.min_kills, entry["tick_rate"])
            sides = await fetch_round_sides(conn, demo_id, rounds=cands) if cands else {}

            # Evaluate each matched SteamID on its own: two players who share a
            # name must never have their kills pooled into a fake multi-kill.
            highlights: list[dict] = []
            for p in matched:
                for h in find_highlights(
                    rounds,
                    deaths,
                    sides,
                    {p["player_id"]},
                    names,
                    entry["tick_rate"],
                    weapons=wanted,
                    min_kills=payload.min_kills,
                    min_weapon_kills=payload.min_weapon_kills,
                ):
                    h["player_id"] = str(p["player_id"])
                    h["player_name"] = p["name"]
                    highlights.append(h)
            highlights.sort(key=lambda h: (h["round_number"], h["first_kill_tick"]))
            entry["highlights"] = highlights

    return {
        "player": query,
        "weapons": sorted(wanted) if wanted else [],
        "min_kills": payload.min_kills,
        "min_weapon_kills": payload.min_weapon_kills if wanted else 0,
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
