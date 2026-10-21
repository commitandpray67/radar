"""
Multi-kill highlight detection for a single player.

Computed purely from stored player_death events plus the authoritative
per-round sides (same inputs as the scoreboard), so no re-parse is needed.

A highlight is a round in which one of the target player's SteamIDs got at
least ``min_kills`` kills (with any guns).  When a weapon filter is given, at
least ``min_weapon_kills`` of those kills must also have been made with one of
``weapons`` — so with deagle, 3K+ and the default of 1, a round of 2 deagle +
1 AK kills counts as a deagle 3K.  Team kills and self-kills never count.
"""

from __future__ import annotations

import bisect

from parser._utils import is_knife_weapon

# Exit frags count only within this many seconds of round_end: CS2's round
# restart delay is ~7 s, so this keeps halftime / tech-pause / post-match deaths
# from being credited to the round before them.
EXIT_FRAG_WINDOW_S = 10.0

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
    # A detached silencer ("m4a1_silencer_off", "usp_silencer_off") is the same gun.
    w = w.removesuffix("_off")
    # Every knife skin ("knife_karambit", "bayonet", "knife_t") counts as knife.
    if is_knife_weapon(w):
        return "knife"
    return WEAPON_ALIASES.get(w, w)


def round_assigner(rounds: list[dict], tick_rate: float):
    """Return ``death -> effective round_number``.

    The parser stores kills made after ``round_end`` (exit frags on saving or
    hiding players) as round 0.  CS2 still counts them for the round that just
    ended, so a kill in the gap between a round's end and the next round's
    start — and within EXIT_FRAG_WINDOW_S of that end — is credited to the
    round that ended.  Kills before the first round (warmup) stay unassigned.
    """
    window = EXIT_FRAG_WINDOW_S * (tick_rate or 64.0)
    timed = sorted(
        (r for r in rounds if r.get("start_tick") is not None and r.get("end_tick") is not None),
        key=lambda r: r["start_tick"],
    )
    starts = [r["start_tick"] for r in timed]

    def assign(d: dict) -> int:
        rn = d.get("round_number") or 0
        if rn or not timed:
            return rn
        tick = d.get("tick") or 0
        idx = bisect.bisect_right(starts, tick) - 1
        if idx >= 0 and 0 < tick - timed[idx]["end_tick"] <= window:
            return timed[idx]["round_number"]
        return 0

    return assign


def _valid_rounds(rounds: list[dict]) -> dict[int, dict]:
    return {
        r["round_number"]: r
        for r in rounds
        if not r.get("is_knife_round") and (r.get("round_number") or 0) > 0
    }


def candidate_rounds(
    rounds: list[dict],
    deaths: list[dict],
    player_ids: set[int],
    min_kills: int,
    tick_rate: float,
) -> set[int]:
    """Rounds where the player has at least ``min_kills`` non-suicide kills.

    A cheap superset of the rounds ``find_highlights`` can return (team kills
    are only removed later), used to fetch round sides for just those rounds.
    """
    valid = _valid_rounds(rounds)
    assign = round_assigner(rounds, tick_rate)
    counts: dict[int, int] = {}
    for d in deaths:
        if d.get("attacker_id") in player_ids and d.get("victim_id") != d.get("attacker_id"):
            rn = assign(d)
            if rn in valid:
                counts[rn] = counts.get(rn, 0) + 1
    return {rn for rn, n in counts.items() if n >= min_kills}


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
    min_weapon_kills: int = 1,
) -> list[dict]:
    """Return the target player's multi-kill rounds, ordered by round number.

    ``rounds``           : dicts with round_number, is_knife_round, winner_team
                           and (optionally) start_tick / end_tick
    ``deaths``           : player_death rows with tick, round_number, attacker_id,
                           victim_id, weapon, headshot
    ``sides``            : round_number -> player_id -> 'CT'|'T'
    ``player_ids``       : the target player's SteamID64(s) in this demo
    ``names``            : player_id -> display name (for the victim list)
    ``weapons``          : weapon tokens (any spelling normalize_weapon accepts),
                           or None/empty for any weapon
    ``min_kills``        : minimum kills in the round, any weapon (the tier)
    ``min_weapon_kills`` : of those, how many must be with ``weapons``
    """
    wanted = {normalize_weapon(w) for w in weapons} if weapons else None
    round_by_num = _valid_rounds(rounds)
    # The app numbers rounds by position among non-knife rounds ("Round N").
    display_round = {
        r["round_number"]: i + 1
        for i, r in enumerate(
            sorted(
                (r for r in rounds if not r.get("is_knife_round")),
                key=lambda r: r["round_number"],
            )
        )
    }
    tick_rate = tick_rate or 64.0
    assign = round_assigner(rounds, tick_rate)

    by_round: dict[int, list[dict]] = {}
    for d in deaths:
        if d.get("attacker_id") not in player_ids:
            continue
        rn = assign(d)
        if rn in round_by_num:
            by_round.setdefault(rn, []).append(d)

    out: list[dict] = []
    for rn in sorted(by_round):
        rsides = sides.get(rn, {})
        kills: list[dict] = []
        for d in sorted(by_round[rn], key=lambda d: d.get("tick") or 0):
            atk, vic = d.get("attacker_id") or 0, d.get("victim_id") or 0
            if atk == vic:
                continue
            a_side, v_side = rsides.get(atk), rsides.get(vic)
            # Skip team kills when we can tell (both sides known and equal).
            if a_side and v_side and a_side == v_side:
                continue
            kills.append(d)

        def _matches(d: dict) -> bool:
            return wanted is None or normalize_weapon(d.get("weapon")) in wanted

        weapon_kills = sum(1 for d in kills if _matches(d))
        if len(kills) < min_kills:
            continue
        if wanted is not None and weapon_kills < min_weapon_kills:
            continue

        side = next((rsides[p] for p in player_ids if p in rsides), None)
        winner = round_by_num[rn].get("winner_team") or None
        first_tick = kills[0].get("tick") or 0
        last_tick = kills[-1].get("tick") or 0
        out.append(
            {
                "round_number": rn,
                "display_round": display_round.get(rn, rn),
                "kills": len(kills),
                "weapon_kills": weapon_kills,
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
                        "matches": _matches(d),
                        # An exit frag: made after round_end, so the round's
                        # replay (which stops at round_end) does not show it.
                        "after_round_end": not (d.get("round_number") or 0),
                    }
                    for d in kills
                ],
            }
        )
    return out
