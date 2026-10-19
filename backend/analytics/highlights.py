"""
Multi-kill highlight detection for a single player.

Computed purely from stored player_death events plus the authoritative
per-round sides (same inputs as the scoreboard), so no re-parse is needed.

A highlight is a round in which one of the target player's SteamIDs got at
least ``min_kills`` kills — counting only kills made with one of ``weapons``
when a weapon filter is given (e.g. a "deagle 3k" = 3+ deagle kills in one
round).  Team kills and self-kills never count.
"""

from __future__ import annotations

# Friendly aliases → the bare weapon tokens demoparser2 reports on player_death.
WEAPON_ALIASES: dict[str, str] = {
    "deserteagle": "deagle",
    "desert_eagle": "deagle",
    "r8": "revolver",
    "m4a4": "m4a1",
    "m4a1-s": "m4a1_silencer",
    "m4a1s": "m4a1_silencer",
    "usp": "usp_silencer",
    "usp-s": "usp_silencer",
    "usps": "usp_silencer",
    "p2000": "hkp2000",
    "cz75": "cz75a",
    "five-seven": "fiveseven",
    "dualies": "elite",
    "scout": "ssg08",
    "galil": "galilar",
    "sg553": "sg556",
}


def normalize_weapon(weapon: str | None) -> str:
    """Lower-case bare weapon token: 'weapon_deagle' / 'Deagle' → 'deagle'."""
    w = (weapon or "").strip().lower()
    if w.startswith("weapon_"):
        w = w[len("weapon_") :]
    # Every knife skin ("knife_karambit", "bayonet", "knife_t") counts as knife.
    if w.startswith("knife") or w == "bayonet":
        return "knife"
    return WEAPON_ALIASES.get(w, w)


def find_highlights(
    rounds: list[dict],
    deaths: list[dict],
    sides: dict[int, dict[int, str]],
    player_ids: set[int],
    names: dict[int, str],
    tick_rate: float,
    *,
    weapons: set[str] | None = None,
    min_kills: int = 3,
) -> list[dict]:
    """Return the target player's multi-kill rounds, ordered by round number.

    ``rounds``     : dicts with round_number, is_knife_round, winner_team
    ``deaths``     : player_death rows with tick, round_number, attacker_id,
                     victim_id, weapon, headshot
    ``sides``      : round_number -> player_id -> 'CT'|'T'
    ``player_ids`` : the target player's SteamID64(s) in this demo
    ``names``      : player_id -> display name (for the victim list)
    ``weapons``    : normalised weapon tokens to count, or None/empty for any
    """
    wanted = {normalize_weapon(w) for w in weapons} if weapons else None
    round_by_num = {
        r["round_number"]: r
        for r in rounds
        if not r.get("is_knife_round") and (r.get("round_number") or 0) > 0
    }
    tick_rate = tick_rate or 64.0

    by_round: dict[int, list[dict]] = {}
    for d in deaths:
        rn = d.get("round_number") or 0
        if rn in round_by_num and d.get("attacker_id") in player_ids:
            by_round.setdefault(rn, []).append(d)

    out: list[dict] = []
    for rn in sorted(by_round):
        rsides = sides.get(rn, {})
        all_kills: list[dict] = []
        for d in sorted(by_round[rn], key=lambda d: d.get("tick") or 0):
            atk, vic = d.get("attacker_id") or 0, d.get("victim_id") or 0
            if atk == vic:
                continue
            a_side, v_side = rsides.get(atk), rsides.get(vic)
            # Skip team kills when we can tell (both sides known and equal).
            if a_side and v_side and a_side == v_side:
                continue
            all_kills.append(d)

        counted = [
            d for d in all_kills if wanted is None or normalize_weapon(d.get("weapon")) in wanted
        ]
        if len(counted) < min_kills:
            continue

        side = next((rsides[p] for p in player_ids if p in rsides), None)
        winner = round_by_num[rn].get("winner_team") or None
        first_tick = counted[0].get("tick") or 0
        last_tick = counted[-1].get("tick") or 0
        out.append(
            {
                "round_number": rn,
                "kills": len(counted),
                "round_kills": len(all_kills),
                "side": side,
                "round_won": (winner == side) if (winner and side) else None,
                "first_kill_tick": first_tick,
                "last_kill_tick": last_tick,
                "duration_s": round((last_tick - first_tick) / tick_rate, 2),
                "kill_list": [
                    {
                        "tick": d.get("tick") or 0,
                        "victim_id": str(d.get("victim_id") or ""),
                        "victim_name": names.get(d.get("victim_id") or 0, ""),
                        "weapon": normalize_weapon(d.get("weapon")),
                        "headshot": bool(d.get("headshot")),
                    }
                    for d in counted
                ],
            }
        )
    return out
