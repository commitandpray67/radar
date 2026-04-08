"""
CS2 demo parser: wraps demoparser2 to produce a normalised intermediate format.

demoparser2 is a Rust-backed Python library that handles the CS2 binary demo
format.  We request only the fields we need so parsing stays fast.

Normalised output schema
------------------------
match_info : dict
  map_name, demo_path, tick_rate, total_ticks

rounds : list[dict]
  round_number, start_tick, end_tick, freeze_end_tick,
  winner_team, win_reason, ct_score, t_score,
  bomb_planted_tick, bomb_defused_tick, bomb_exploded_tick

players : list[dict]
  player_id (steam_id), name, initial_team

player_positions : list[dict]
  tick, round_number, player_id, x, y, z, team_num, is_alive

events : list[dict]
  tick, round_number, event_type, attacker_id, victim_id, weapon, headshot
"""

from __future__ import annotations

import os
import time
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional, Callable
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data classes for the normalised schema
# ---------------------------------------------------------------------------

@dataclass
class MatchInfo:
    map_name: str
    demo_path: str
    tick_rate: float
    total_ticks: int


@dataclass
class RoundInfo:
    round_number: int
    start_tick: int
    end_tick: int
    freeze_end_tick: int
    winner_team: str          # "CT" | "T" | ""
    win_reason: str
    ct_score: int
    t_score: int
    bomb_planted_tick: Optional[int] = None
    bomb_defused_tick: Optional[int] = None
    bomb_exploded_tick: Optional[int] = None


@dataclass
class PlayerInfo:
    player_id: int            # SteamID64
    name: str
    initial_team: str         # "CT" | "T" | "Spectator"


@dataclass
class PlayerPosition:
    tick: int
    round_number: int
    player_id: int
    x: float
    y: float
    z: float
    team_num: int             # 2 = T, 3 = CT
    is_alive: bool


@dataclass
class GameEvent:
    tick: int
    round_number: int
    event_type: str           # "player_death", "bomb_planted", etc.
    attacker_id: Optional[int] = None
    victim_id: Optional[int] = None
    weapon: Optional[str] = None
    headshot: bool = False


@dataclass
class ParsedDemo:
    match_info: MatchInfo
    rounds: list[RoundInfo] = field(default_factory=list)
    players: list[PlayerInfo] = field(default_factory=list)
    positions: list[PlayerPosition] = field(default_factory=list)
    events: list[GameEvent] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Parser implementation
# ---------------------------------------------------------------------------

def parse_demo(
    demo_path: str | Path,
    position_sample_rate: int = 8,
    progress_callback: Optional[Callable[[float, str], None]] = None,
) -> ParsedDemo:
    """
    Parse a CS2 demo file and return a normalised ParsedDemo.

    Parameters
    ----------
    demo_path : path to the .dem file
    position_sample_rate : sample one position record every N game ticks.
                           Valve demos run at 64 tick; 8 = ~8 Hz sample rate.
                           Lower values produce smoother visualisations at the
                           cost of larger datasets.
    progress_callback : optional callable(fraction: float, message: str)
                        called during parsing to report progress (0.0 → 1.0).
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

    # ---- Header / match info ------------------------------------------------
    _progress(0.02, "Reading header")
    header = parser.parse_header()
    map_name: str = header.get("map_name", "unknown")
    tick_rate: float = float(header.get("playback_ticks", 0)) / max(
        float(header.get("playback_time", 1)), 1
    )
    total_ticks: int = int(header.get("playback_ticks", 0))

    match_info = MatchInfo(
        map_name=map_name,
        demo_path=str(demo_path),
        tick_rate=round(tick_rate, 2),
        total_ticks=total_ticks,
    )

    # ---- Rounds  -------------------------------------------------------------
    _progress(0.05, "Extracting round boundaries")
    rounds = _extract_rounds(parser)

    # ---- Player roster -------------------------------------------------------
    _progress(0.15, "Extracting player roster")
    players = _extract_players(parser)

    # ---- Player positions  ---------------------------------------------------
    _progress(0.20, "Sampling player positions")
    positions = _extract_positions(
        parser, rounds, position_sample_rate, _progress
    )

    # ---- Game events  --------------------------------------------------------
    _progress(0.90, "Extracting game events")
    events = _extract_events(parser, rounds)

    _progress(1.0, "Parsing complete")

    return ParsedDemo(
        match_info=match_info,
        rounds=rounds,
        players=players,
        positions=positions,
        events=events,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _extract_rounds(parser) -> list[RoundInfo]:
    """Build a list of RoundInfo from round_start/round_end events."""
    try:
        round_starts = parser.parse_event("round_start", other=["tick"])
        round_ends = parser.parse_event(
            "round_officially_ended",
            other=["tick", "winner", "reason", "ct_score", "t_score"],
        )
        freeze_ends = parser.parse_event("round_freeze_end", other=["tick"])
        bomb_plants = parser.parse_event("bomb_planted", other=["tick"])
        bomb_defuses = parser.parse_event("bomb_defused", other=["tick"])
        bomb_explodes = parser.parse_event("bomb_exploded", other=["tick"])
    except Exception as exc:
        logger.warning("Could not parse round events: %s", exc)
        return []

    # Build lookup: round_number → ticks for each auxiliary event
    plant_ticks: dict[int, int] = {}
    defuse_ticks: dict[int, int] = {}
    explode_ticks: dict[int, int] = {}

    # We assign bomb events to rounds by matching tick to nearest round window
    # (done after we have start/end tick pairs)

    # Build start tick list from round_start events
    start_rows = sorted(round_starts.to_dict("records"), key=lambda r: r["tick"])
    end_rows = sorted(round_ends.to_dict("records"), key=lambda r: r["tick"])
    freeze_rows = sorted(freeze_ends.to_dict("records"), key=lambda r: r["tick"])

    rounds: list[RoundInfo] = []
    for i, start_row in enumerate(start_rows):
        start_tick = int(start_row["tick"])
        round_num = i + 1

        # End tick = the matching round_end (first one after start_tick)
        matching_ends = [r for r in end_rows if r["tick"] > start_tick]
        if matching_ends:
            end_row = matching_ends[0]
            end_tick = int(end_row["tick"])
            winner = str(end_row.get("winner", "")).upper()
            # Valve gives 2=T, 3=CT; map to string
            if winner == "2":
                winner = "T"
            elif winner == "3":
                winner = "CT"
            win_reason = str(end_row.get("reason", ""))
            ct_score = int(end_row.get("ct_score", 0) or 0)
            t_score = int(end_row.get("t_score", 0) or 0)
        else:
            # Incomplete last round
            end_tick = start_tick
            winner, win_reason = "", ""
            ct_score = t_score = 0

        # Freeze end tick
        matching_freezes = [r for r in freeze_rows if start_tick <= r["tick"] <= end_tick]
        freeze_end_tick = int(matching_freezes[0]["tick"]) if matching_freezes else start_tick

        rounds.append(
            RoundInfo(
                round_number=round_num,
                start_tick=start_tick,
                end_tick=end_tick,
                freeze_end_tick=freeze_end_tick,
                winner_team=winner,
                win_reason=win_reason,
                ct_score=ct_score,
                t_score=t_score,
            )
        )

    # Assign bomb events to rounds
    for bomb_row in (bomb_plants.to_dict("records") if not bomb_plants.empty else []):
        tick = int(bomb_row["tick"])
        for r in rounds:
            if r.start_tick <= tick <= r.end_tick:
                r.bomb_planted_tick = tick
                break

    for bomb_row in (bomb_defuses.to_dict("records") if not bomb_defuses.empty else []):
        tick = int(bomb_row["tick"])
        for r in rounds:
            if r.start_tick <= tick <= r.end_tick:
                r.bomb_defused_tick = tick
                break

    for bomb_row in (bomb_explodes.to_dict("records") if not bomb_explodes.empty else []):
        tick = int(bomb_row["tick"])
        for r in rounds:
            if r.start_tick <= tick <= r.end_tick:
                r.bomb_exploded_tick = tick
                break

    return rounds


def _extract_players(parser) -> list[PlayerInfo]:
    """Extract a unique player roster from the demo."""
    try:
        # parse_ticks returns a DataFrame; we use a small set of props
        df = parser.parse_ticks(
            ["name", "team_name", "steamid"],
            ticks=[0],  # first tick only for roster
        )
    except Exception as exc:
        logger.warning("Could not extract player roster: %s", exc)
        return []

    players: list[PlayerInfo] = []
    seen: set[int] = set()

    for row in df.to_dict("records"):
        steam_id = int(row.get("steamid", 0) or 0)
        if steam_id == 0 or steam_id in seen:
            continue
        seen.add(steam_id)
        team = str(row.get("team_name", "") or "").strip()
        players.append(
            PlayerInfo(
                player_id=steam_id,
                name=str(row.get("name", "") or ""),
                initial_team=team,
            )
        )

    return players


def _extract_positions(
    parser,
    rounds: list[RoundInfo],
    sample_rate: int,
    progress_cb: Callable[[float, str], None],
) -> list[PlayerPosition]:
    """
    Sample player positions at `sample_rate` ticks throughout the match.

    We sample only within valid round windows to avoid lobby/warmup noise.
    """
    if not rounds:
        return []

    # Build the list of ticks to sample
    all_ticks: list[int] = []
    for r in rounds:
        start = max(r.start_tick, r.freeze_end_tick)  # skip freeze time
        ticks_in_round = list(range(start, r.end_tick + 1, sample_rate))
        all_ticks.extend(ticks_in_round)

    if not all_ticks:
        return []

    progress_cb(0.25, f"Requesting {len(all_ticks):,} position ticks from parser")

    try:
        df = parser.parse_ticks(
            [
                "X", "Y", "Z",
                "team_num",
                "is_alive",
                "steamid",
            ],
            ticks=all_ticks,
        )
    except Exception as exc:
        logger.error("Failed to parse position ticks: %s", exc)
        return []

    progress_cb(0.60, f"Processing {len(df):,} position rows")

    # Build a tick → round_number lookup (fast)
    tick_to_round: dict[int, int] = {}
    for r in rounds:
        start = max(r.start_tick, r.freeze_end_tick)
        for t in range(start, r.end_tick + 1, sample_rate):
            tick_to_round[t] = r.round_number

    positions: list[PlayerPosition] = []
    records = df.to_dict("records")

    for i, row in enumerate(records):
        if i % 50_000 == 0 and i > 0:
            progress_cb(
                0.60 + 0.28 * (i / len(records)),
                f"Processing positions {i:,}/{len(records):,}",
            )

        steam_id = int(row.get("steamid", 0) or 0)
        if steam_id == 0:
            continue

        tick = int(row.get("tick", 0) or 0)
        rn = tick_to_round.get(tick, 0)
        if rn == 0:
            continue

        x = float(row.get("X", 0) or 0)
        y = float(row.get("Y", 0) or 0)
        z = float(row.get("Z", 0) or 0)

        # Skip positions at origin (player not spawned)
        if x == 0 and y == 0 and z == 0:
            continue

        positions.append(
            PlayerPosition(
                tick=tick,
                round_number=rn,
                player_id=steam_id,
                x=x,
                y=y,
                z=z,
                team_num=int(row.get("team_num", 0) or 0),
                is_alive=bool(row.get("is_alive", False)),
            )
        )

    return positions


def _extract_events(parser, rounds: list[RoundInfo]) -> list[GameEvent]:
    """Extract kill events and bomb events."""
    events: list[GameEvent] = []

    tick_to_round: dict[int, int] = {}
    for r in rounds:
        for t in range(r.start_tick, r.end_tick + 1):
            tick_to_round[t] = r.round_number

    def _round_for_tick(tick: int) -> int:
        return tick_to_round.get(tick, 0)

    # ----- Kills -----
    try:
        kills_df = parser.parse_event(
            "player_death",
            other=[
                "tick", "attacker_steamid", "user_steamid",
                "weapon", "headshot",
            ],
        )
        for row in kills_df.to_dict("records"):
            tick = int(row.get("tick", 0) or 0)
            events.append(
                GameEvent(
                    tick=tick,
                    round_number=_round_for_tick(tick),
                    event_type="player_death",
                    attacker_id=int(row.get("attacker_steamid", 0) or 0) or None,
                    victim_id=int(row.get("user_steamid", 0) or 0) or None,
                    weapon=str(row.get("weapon", "") or ""),
                    headshot=bool(row.get("headshot", False)),
                )
            )
    except Exception as exc:
        logger.warning("Could not parse player_death events: %s", exc)

    # ----- Bomb events -----
    for event_name in ("bomb_planted", "bomb_defused", "bomb_exploded"):
        try:
            df = parser.parse_event(event_name, other=["tick"])
            for row in df.to_dict("records"):
                tick = int(row.get("tick", 0) or 0)
                events.append(
                    GameEvent(
                        tick=tick,
                        round_number=_round_for_tick(tick),
                        event_type=event_name,
                    )
                )
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    return sorted(events, key=lambda e: e.tick)
