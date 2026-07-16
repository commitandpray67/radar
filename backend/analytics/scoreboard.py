"""
Per-demo scoreboard aggregation.

Computed purely from data already stored by the parser — player_death events
(attacker/victim/headshot) plus the authoritative per-round sides — so no
re-parse is needed.

Metrics that require damage or assist data (ADR, assists, assist-inclusive
KAST) are NOT derivable from the current schema: player_hurt rows store only
the victim's post-damage HP, with no attacker and no damage amount.  Those
fields are returned as null and flagged via ``has_damage_data=False`` so the
UI can render "—" until (optionally) the parser is extended.
"""

from __future__ import annotations

# Kills within this many seconds of a teammate's death count as a trade.
_TRADE_WINDOW_SECONDS = 5.0


def _blank(pid: int, name: str, initial_team: str) -> dict:
    return {
        "player_id": pid,
        "name": name,
        "initial_team": initial_team,
        "rounds": 0,
        "kills": 0,
        "deaths": 0,
        "kd": 0.0,
        "hs_kills": 0,
        "hs_pct": 0.0,
        "kpr": 0.0,
        "opening_kills": 0,
        "opening_deaths": 0,
        "opening_wins": 0,
        "opening_losses": 0,
        "trade_kills": 0,
        "traded_deaths": 0,
        "traded_death_pct": 0.0,
        "multikills": {"2": 0, "3": 0, "4": 0, "5": 0},
        "rounds_survived": 0,
        "kast": 0.0,
        # Not derivable from stored data (no attacker/damage on player_hurt):
        "assists": None,
        "adr": None,
        "has_damage_data": False,
        "kast_includes_assists": False,
    }


def compute_scoreboard(
    rounds: list[dict],
    deaths: list[dict],
    sides: dict[int, dict[int, str]],
    players: list[dict],
    tick_rate: float,
) -> list[dict]:
    """Aggregate a per-player scoreboard.

    ``rounds``  : dicts with round_number, is_knife_round, winner_team ('CT'/'T'/'')
    ``deaths``  : player_death rows with tick, round_number, attacker_id,
                  victim_id, headshot
    ``sides``   : round_number -> player_id -> 'CT'|'T'
    ``players`` : dicts with player_id, name, initial_team
    """
    valid_rounds = {
        r["round_number"]
        for r in rounds
        if not r.get("is_knife_round") and (r.get("round_number") or 0) > 0
    }
    winner_by_round = {r["round_number"]: (r.get("winner_team") or "") for r in rounds}
    n_rounds = len(valid_rounds)
    trade_ticks = max(1, round(_TRADE_WINDOW_SECONDS * (tick_rate or 64.0)))

    stats: dict[int, dict] = {
        p["player_id"]: _blank(p["player_id"], p.get("name", ""), p.get("initial_team", ""))
        for p in players
    }
    kast_rounds: dict[int, set] = {pid: set() for pid in stats}

    # Group deaths by round, ordered by tick.
    by_round: dict[int, list[dict]] = {}
    for d in deaths:
        rn = d.get("round_number")
        if rn in valid_rounds:
            by_round.setdefault(rn, []).append(d)
    for lst in by_round.values():
        lst.sort(key=lambda d: d.get("tick") or 0)

    for rn in valid_rounds:
        rsides = sides.get(rn, {})
        dl = by_round.get(rn, [])
        round_kills: dict[int, int] = {}
        killed: set[int] = set()
        traded_this_round: set[int] = set()

        # Opening duel = the round's first death.
        if dl:
            first = dl[0]
            atk, vic = first.get("attacker_id"), first.get("victim_id")
            if atk in stats:
                stats[atk]["opening_kills"] += 1
                winner = winner_by_round.get(rn)
                atk_side = rsides.get(atk)
                if winner and atk_side:
                    if winner == atk_side:
                        stats[atk]["opening_wins"] += 1
                    else:
                        stats[atk]["opening_losses"] += 1
            if vic in stats:
                stats[vic]["opening_deaths"] += 1

        for i, d in enumerate(dl):
            atk, vic, hs = d.get("attacker_id"), d.get("victim_id"), d.get("headshot")
            if vic in stats:
                stats[vic]["deaths"] += 1
                killed.add(vic)

            if atk in stats and atk != vic:
                a_side, v_side = rsides.get(atk), rsides.get(vic)
                # Skip team kills when we can tell (both sides known and equal).
                if a_side and v_side and a_side == v_side:
                    continue
                stats[atk]["kills"] += 1
                if hs:
                    stats[atk]["hs_kills"] += 1
                round_kills[atk] = round_kills.get(atk, 0) + 1

                # Trade: did this kill avenge a teammate the victim killed
                # within the trade window?
                for prior in dl[:i]:
                    if (
                        prior.get("attacker_id") == vic
                        and (d.get("tick") or 0) - (prior.get("tick") or 0) <= trade_ticks
                    ):
                        pv = prior.get("victim_id")
                        if a_side and rsides.get(pv) == a_side:
                            stats[atk]["trade_kills"] += 1
                            if pv in stats:
                                stats[pv]["traded_deaths"] += 1
                                traded_this_round.add(pv)
                            break

        for pid, c in round_kills.items():
            if c >= 2:
                stats[pid]["multikills"][str(min(c, 5))] += 1

        # Per-round participation + KAST (kill / survived / traded; no assists).
        for pid, st in stats.items():
            in_round = pid in rsides or pid in round_kills or pid in killed
            if not in_round:
                continue
            st["rounds"] += 1
            survived = pid not in killed
            if survived:
                st["rounds_survived"] += 1
            if round_kills.get(pid, 0) > 0 or survived or pid in traded_this_round:
                kast_rounds[pid].add(rn)

    # Finalise derived ratios.
    for pid, st in stats.items():
        rp = st["rounds"] or 0
        st["kd"] = round(st["kills"] / st["deaths"], 2) if st["deaths"] else float(st["kills"])
        st["hs_pct"] = round(st["hs_kills"] / st["kills"], 4) if st["kills"] else 0.0
        st["kpr"] = round(st["kills"] / rp, 2) if rp else 0.0
        st["traded_death_pct"] = (
            round(st["traded_deaths"] / st["deaths"], 4) if st["deaths"] else 0.0
        )
        st["kast"] = round(len(kast_rounds[pid]) / n_rounds, 4) if n_rounds else 0.0

    # Sort by kills desc, then K/D — a sensible default the UI can re-sort.
    return sorted(stats.values(), key=lambda s: (s["kills"], s["kd"]), reverse=True)
