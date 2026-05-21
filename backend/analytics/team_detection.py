"""
Team-detection for multi-demo team analysis sessions.

Given several demos, identify the player roster that consistently appears on
ONE side across all demos.  Each demo only needs ≥4 overlapping players with
the running core roster, allowing for a single substitute per match.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

MIN_OVERLAP = 4   # require at least 4 shared SteamIDs to call a demo "the same team"


@dataclass
class DemoRoster:
    demo_id: str
    map_name: str
    ct: set[int]   # SteamID64s that started CT
    t:  set[int]   # SteamID64s that started T


@dataclass
class TeamDetectionResult:
    ok: bool
    error: Optional[str]
    map_name: Optional[str]
    core_roster: list[int]        # SteamID64s present in ALL demos on the matched side
    extended_roster: list[int]    # union of all matched-side rosters (incl. subs)
    team_sides: dict[str, str]    # demo_id -> "CT" | "T" — which side the team played


def detect_team(rosters: list[DemoRoster]) -> TeamDetectionResult:
    """
    Find the largest team identity that fits all demos.

    Algorithm:
      1. Reject if demos span multiple maps.
      2. Try both sides of demo[0] as the candidate team.
      3. For each subsequent demo, intersect the running core with each side
         and pick the better fit.  Require ≥4 overlap; otherwise the candidate
         fails for that ordering.
      4. Among successful candidates, pick the one with the largest core roster
         (and largest extended roster as a tiebreaker).
    """
    if not rosters:
        return TeamDetectionResult(
            ok=False, error="No demos provided",
            map_name=None, core_roster=[], extended_roster=[], team_sides={},
        )

    # 1. Same-map check
    maps = {r.map_name for r in rosters}
    if len(maps) > 1:
        return TeamDetectionResult(
            ok=False,
            error=f"Demos are from different maps: {', '.join(sorted(maps))}",
            map_name=None, core_roster=[], extended_roster=[], team_sides={},
        )

    map_name = next(iter(maps))

    # 2. Try each seed side from demo[0]
    best: Optional[tuple[set[int], set[int], dict[str, str]]] = None
    best_score: tuple[int, int] = (-1, -1)

    for seed_side in ("CT", "T"):
        seed = getattr(rosters[0], seed_side.lower())
        if len(seed) < MIN_OVERLAP:
            continue

        core = set(seed)
        extended = set(seed)
        team_sides = {rosters[0].demo_id: seed_side}
        success = True

        for d in rosters[1:]:
            ct_inter = core & d.ct
            t_inter  = core & d.t
            # Pick the side with larger overlap; require ≥4
            if len(ct_inter) >= len(t_inter) and len(ct_inter) >= MIN_OVERLAP:
                team_sides[d.demo_id] = "CT"
                core = ct_inter
                extended |= d.ct
            elif len(t_inter) >= MIN_OVERLAP:
                team_sides[d.demo_id] = "T"
                core = t_inter
                extended |= d.t
            else:
                success = False
                break

        if success:
            score = (len(core), len(extended))
            if score > best_score:
                best_score = score
                best = (core, extended, team_sides)

    if best is None:
        return TeamDetectionResult(
            ok=False,
            error=(
                f"Could not detect a consistent team across all demos "
                f"(need ≥{MIN_OVERLAP} shared players on the same side)."
            ),
            map_name=map_name, core_roster=[], extended_roster=[], team_sides={},
        )

    core, extended, team_sides = best
    return TeamDetectionResult(
        ok=True, error=None, map_name=map_name,
        core_roster=sorted(core),
        extended_roster=sorted(extended),
        team_sides=team_sides,
    )
