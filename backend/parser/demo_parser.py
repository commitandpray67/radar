"""
CS2 demo parser: wraps demoparser2 to produce a normalised ParsedDemo.

demoparser2 >= 0.14 returns Polars DataFrames (not Pandas).
All DataFrame access uses the Polars API:
  df.rows(named=True)   instead of df.to_dict("records")
  df.is_empty()         instead of len(df) == 0

Normalised output schema
------------------------
match_info : MatchInfo
  map_name, demo_path, tick_rate, total_ticks

rounds : list[RoundInfo]
  round_number, start_tick, end_tick, freeze_end_tick,
  winner_team, win_reason, ct_score, t_score,
  bomb_planted_tick, bomb_defused_tick, bomb_exploded_tick

players : list[PlayerInfo]
  player_id (SteamID64), name, initial_team

positions : list[PlayerPosition]
  tick, round_number, player_id, x, y, z, team_num, is_alive, yaw

events : list[GameEvent]
  tick, round_number, event_type, attacker_id, victim_id, weapon, headshot

grenades : list[GrenadeEvent]
  round_number, thrower_id, grenade_type, throw_tick, detonate_tick, x, y, z,
  expire_tick, trajectory

player_state_events : list[PlayerStateEvent]
  tick, round_number, player_id, event_type, hp, armor, weapon
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

from ._events import _extract_economy, _extract_events, _extract_player_state_events
from ._grenades import _extract_grenades
from ._positions import _extract_positions
from ._rounds import _extract_rounds, _infer_initial_teams
from ._types import (  # noqa: F401  (re-exported for callers)
    GameEvent,
    GrenadeEvent,
    MatchInfo,
    ParsedDemo,
    PlayerInfo,
    PlayerPosition,
    PlayerStateEvent,
    RoundInfo,
)
from ._utils import _rows

logger = logging.getLogger(__name__)

# Bump when round-extraction or schema logic changes so cached demos are re-parsed.
# v29: fixed the grenade-trajectory "webbing" (tick-batched tracker with
#      per-tick exclusive assignment) — stored trajectories need a re-parse.
PARSER_VERSION = 29


# ---------------------------------------------------------------------------
# Player roster
# ---------------------------------------------------------------------------


def _extract_players(parser) -> list[PlayerInfo]:
    """Extract the player roster via parse_player_info (Polars-aware)."""
    try:
        df = parser.parse_player_info()
    except Exception as exc:
        logger.warning("parse_player_info failed, falling back to parse_ticks: %s", exc)
        try:
            df = parser.parse_ticks(["name", "team_name", "steamid"], ticks=[1])
        except Exception as exc2:
            logger.warning("Could not extract player roster: %s", exc2)
            return []

    players: list[PlayerInfo] = []
    seen: set[int] = set()

    for row in _rows(df):
        raw_id = row.get("steamid", 0) or 0
        try:
            steam_id = int(raw_id)
        except (ValueError, TypeError):
            continue
        if steam_id == 0 or steam_id in seen:
            continue
        seen.add(steam_id)

        team_num = int(row.get("team_number", 0) or 0)
        team = {2: "T", 3: "CT"}.get(team_num, "") or str(row.get("team_name", "") or "")

        players.append(
            PlayerInfo(
                player_id=steam_id,
                name=str(row.get("name", "") or ""),
                initial_team=team,
            )
        )

    return players


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def parse_demo(
    demo_path: str | Path,
    position_sample_rate: int = 8,
    progress_callback: Callable[[float, str], None] | None = None,
) -> ParsedDemo:
    """
    Parse a CS2 demo file and return a normalised ParsedDemo.

    Parameters
    ----------
    demo_path
        Path to the .dem file.
    position_sample_rate
        Sample every Nth tick for positions (64-tick demo + rate=8 gives
        ~8 position samples per second).
    progress_callback
        Optional callable(fraction: float, message: str) for UI progress.
    """
    demo_path = Path(demo_path)
    if not demo_path.exists():
        raise FileNotFoundError(f"Demo file not found: {demo_path}")

    def _progress(frac: float, msg: str) -> None:
        if progress_callback:
            progress_callback(frac, msg)
        logger.debug("parse %.0f%% — %s", frac * 100, msg)

    _progress(0.0, "Opening demo file")

    try:
        from demoparser2 import DemoParser  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "demoparser2 is required. Install it with: pip install demoparser2"
        ) from exc

    parser = DemoParser(str(demo_path))

    # ---- Header / match info -----------------------------------------------
    _progress(0.02, "Reading header")
    header = parser.parse_header()
    map_name: str = header.get("map_name", "unknown")
    playback_ticks: int = int(header.get("playback_ticks", 0))
    playback_time: float = float(header.get("playback_time", 1) or 1)
    tick_rate = (
        round(playback_ticks / playback_time, 2)
        if playback_ticks > 0 and playback_time > 0
        else 64.0
    )

    match_info = MatchInfo(
        map_name=map_name,
        demo_path=str(demo_path),
        tick_rate=tick_rate,
        total_ticks=playback_ticks,
    )

    # ---- Rounds ------------------------------------------------------------
    _progress(0.05, "Extracting round boundaries")
    rounds = _extract_rounds(parser, tick_rate=tick_rate)

    # ---- Player roster -----------------------------------------------------
    _progress(0.15, "Extracting player roster")
    players = _extract_players(parser)

    # ---- Player positions --------------------------------------------------
    _progress(0.20, "Sampling player positions")
    positions = _extract_positions(parser, rounds, position_sample_rate, _progress)

    # ---- Game events -------------------------------------------------------
    _progress(0.90, "Extracting game events")
    events = _extract_events(parser, rounds, map_name=map_name)

    # ---- Grenades ----------------------------------------------------------
    _progress(0.92, "Extracting grenade events")
    grenades = _extract_grenades(parser, rounds, tick_rate)

    # ---- Economy -----------------------------------------------------------
    _progress(0.93, "Extracting economy data")
    rounds = _extract_economy(parser, rounds)

    # ---- Player state events -----------------------------------------------
    _progress(0.94, "Extracting player state events")
    player_state_events = _extract_player_state_events(parser, rounds, tick_rate)

    # ---- Correct initial_team from live position data ----------------------
    # parse_player_info() reflects the END of the demo (post-halftime), so
    # team assignments are flipped.  We override from first non-knife round
    # positions which are pre-halftime and canonical.
    _progress(0.95, "Correcting initial team assignments")
    initial_teams = _infer_initial_teams(positions, rounds)
    players = [
        PlayerInfo(
            player_id=p.player_id,
            name=p.name,
            initial_team=initial_teams.get(p.player_id, p.initial_team),
        )
        for p in players
    ]

    # ---- Sanity checks -----------------------------------------------------
    # A demoparser2 schema change (after a CS2 update) can make an event query
    # return nothing rather than raising, leaving a demo that looks parsed but
    # is silently missing whole feature sets. Warn loudly so it's visible in
    # the logs instead of surfacing as a confusing empty UI.
    non_knife = [r for r in rounds if not r.is_knife_round]
    if rounds and not events:
        logger.warning("Demo %s parsed with 0 game events — parser may be out of date", map_name)
    elif len(non_knife) >= 5 and not any(e.event_type == "player_death" for e in events):
        logger.warning(
            "Demo %s has %d rounds but 0 kills — kill extraction likely failed",
            map_name,
            len(non_knife),
        )
    if len(non_knife) >= 5 and not grenades:
        logger.warning(
            "Demo %s has %d rounds but 0 grenades — grenade extraction may have failed",
            map_name,
            len(non_knife),
        )

    _progress(1.0, "Parsing complete")
    return ParsedDemo(
        match_info=match_info,
        rounds=rounds,
        players=players,
        positions=positions,
        events=events,
        grenades=grenades,
        player_state_events=player_state_events,
    )
