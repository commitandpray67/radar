"""
CS2 demo parser: wraps demoparser2 to produce a normalised intermediate format.

demoparser2 >= 0.14 returns Polars DataFrames (not Pandas).
All DataFrame access uses the Polars API:
  df.rows(named=True)   instead of df.to_dict("records")
  df.is_empty()         instead of df.empty
  len(df)               works the same

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

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Callable

logger = logging.getLogger(__name__)

# Bump this when round-extraction logic changes so cached demos get re-parsed.
PARSER_VERSION = 5


# ---------------------------------------------------------------------------
# Polars helper: convert any DataFrame (Polars or Pandas) to list[dict]
# ---------------------------------------------------------------------------

def _rows(df) -> list[dict]:
    """
    Return rows as a list of dicts.
    Handles Polars DataFrames, Pandas DataFrames, and plain Python lists
    (demoparser2 v0.41 returns a list for some events with no data).
    """
    if isinstance(df, list):
        return df                           # already a list (possibly of dicts)
    try:
        return df.rows(named=True)          # Polars DataFrame
    except AttributeError:
        return df.to_dict("records")        # Pandas DataFrame


def _is_empty(df) -> bool:
    """Return True if the result has no rows."""
    if isinstance(df, list):
        return len(df) == 0
    try:
        return df.is_empty()                # Polars
    except AttributeError:
        return len(df) == 0                 # Pandas / anything with len()


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
    is_knife_round: bool = False


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
    event_type: str
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
# Parser entry point
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
    position_sample_rate : sample every Nth tick for positions (64-tick demo,
                           rate=8 gives ~8 position samples per second).
    progress_callback : optional callable(fraction: float, message: str)
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

    # ---- Header / match info -------------------------------------------
    _progress(0.02, "Reading header")
    header = parser.parse_header()
    # parse_header() in demoparser2 >= 0.41 returns the "header message"
    # which contains map_name but NOT playback_ticks / playback_time.
    # CS2 live-service demos run at 64 tick; FACEIT at 128 tick.
    # We default to 64 and refine below from actual tick data if possible.
    map_name: str = header.get("map_name", "unknown")
    playback_ticks = int(header.get("playback_ticks", 0))
    playback_time  = float(header.get("playback_time", 1) or 1)
    if playback_ticks > 0 and playback_time > 0:
        tick_rate = round(playback_ticks / playback_time, 2)
    else:
        tick_rate = 64.0  # safe default for CS2

    match_info = MatchInfo(
        map_name=map_name,
        demo_path=str(demo_path),
        tick_rate=tick_rate,
        total_ticks=playback_ticks,
    )

    # ---- Rounds --------------------------------------------------------
    _progress(0.05, "Extracting round boundaries")
    rounds = _extract_rounds(parser, tick_rate=tick_rate)

    # ---- Player roster -------------------------------------------------
    _progress(0.15, "Extracting player roster")
    players = _extract_players(parser)

    # ---- Player positions ----------------------------------------------
    _progress(0.20, "Sampling player positions")
    positions = _extract_positions(parser, rounds, position_sample_rate, _progress)

    # ---- Game events ---------------------------------------------------
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

def _parse_winner(raw) -> str:
    """Normalise the winner field from any round-end event to 'CT', 'T', or ''."""
    s = str(raw or "").strip().upper()
    if s in ("2", "T", "TERRORIST"):
        return "T"
    if s in ("3", "CT", "COUNTERTERRORIST"):
        return "CT"
    return ""


def _extract_rounds(parser, tick_rate: float = 64.0) -> list[RoundInfo]:
    """
    Build RoundInfo list from round events.

    Strategy (demoparser2 v0.41 / CS2):
      1. Pair every round_end with its immediately-preceding round_start
         (each event consumed at most once → orphaned starts are discarded).
      2. Detect real-match boundaries via ``begin_new_match`` /
         ``round_announce_match_start`` events and discard any rounds whose
         start_tick falls before the match-start marker.
      3. Detect halftime transition rounds via ``announce_phase_end`` events:
         any round whose start_tick is between a phase-end tick and the next
         real-match round_freeze_end is a server-generated transition round
         and is discarded.
      4. Fallback: short-duration filter (< 13 s) catches any remaining
         non-game rounds.
    """
    MIN_ROUND_TICKS = int(13 * tick_rate)

    # ---- round_start (required) --------------------------------------------
    try:
        round_starts_raw = parser.parse_event("round_start", other=["tick"])
    except Exception as exc:
        logger.warning("Could not parse round_start: %s", exc)
        return []

    start_rows = sorted(_rows(round_starts_raw), key=lambda r: r.get("tick", 0))
    if not start_rows:
        return []

    # ---- round end events (try round_end first, then round_officially_ended)
    end_rows: list[dict] = []
    for event_name in ("round_end", "round_officially_ended"):
        try:
            df = parser.parse_event(
                event_name, other=["tick", "winner", "reason"]
            )
            rows = _rows(df)
            if rows:
                end_rows = sorted(rows, key=lambda r: r.get("tick", 0))
                logger.info("Round-end source: %s (%d events)", event_name, len(rows))
                break
        except Exception as exc:
            logger.debug("Event %s unavailable: %s", event_name, exc)

    # ---- freeze-end and bomb events ----------------------------------------
    def _safe_event(name, other):
        try:
            return parser.parse_event(name, other=other)
        except Exception:
            return []

    freeze_ends  = _safe_event("round_freeze_end", ["tick"])
    bomb_plants  = _safe_event("bomb_planted",      ["tick"])
    bomb_defuses = _safe_event("bomb_defused",      ["tick"])
    bomb_explodes= _safe_event("bomb_exploded",     ["tick"])

    freeze_rows = sorted(_rows(freeze_ends), key=lambda r: r.get("tick", 0))

    logger.info(
        "Raw events: %d round_start, %d round_end, %d freeze_end",
        len(start_rows), len(end_rows), len(freeze_rows),
    )

    # ---- Pair each round_end with its latest preceding unused round_start --
    start_ticks_sorted = sorted(int(r.get("tick", 0)) for r in start_rows)
    used_start_ticks: set[int] = set()

    pairs: list[tuple[int, int, str, str]] = []  # (start, end, winner, reason)

    for end_row in end_rows:
        end_tick = int(end_row.get("tick", 0))
        winner   = _parse_winner(end_row.get("winner", ""))
        reason   = str(end_row.get("reason", "") or "")

        best_start: int | None = None
        for st in reversed(start_ticks_sorted):
            if st < end_tick and st not in used_start_ticks:
                best_start = st
                break

        if best_start is None:
            continue

        used_start_ticks.add(best_start)
        pairs.append((best_start, end_tick, winner, reason))

    pairs.sort(key=lambda x: x[0])

    # Log every paired round BEFORE filtering (crucial for diagnosis)
    for i, (s, e, w, rsn) in enumerate(pairs, 1):
        logger.info(
            "  raw R%02d  ticks %d–%d  dur=%d (%.1fs)  winner=%-2s  reason=%s",
            i, s, e, e - s, (e - s) / tick_rate, w or "--", rsn or "--",
        )

    # ---- Filter 1: reason-code filter ----------------------------------------
    # CS2 uses RoundEndReason_GameStart (reason=16) for rounds that end because
    # the game is transitioning (warmup→match, first half→second half).
    # These are not real competitive rounds and must be discarded.
    TRANSITION_REASONS = {"16"}
    transition = [(s, e, w, r) for s, e, w, r in pairs if r in TRANSITION_REASONS]
    pairs      = [(s, e, w, r) for s, e, w, r in pairs if r not in TRANSITION_REASONS]
    if transition:
        logger.info(
            "Removed %d transition round(s) by reason=16 (GameStart): %s",
            len(transition),
            [(s, e, rsn) for s, e, _, rsn in transition],
        )

    # ---- Filter 2: short-duration fallback ---------------------------------
    short = [(s, e, w, r) for s, e, w, r in pairs if e - s < MIN_ROUND_TICKS]
    pairs = [(s, e, w, r) for s, e, w, r in pairs if e - s >= MIN_ROUND_TICKS]
    if short:
        logger.info(
            "Removed %d short round(s) (< %d ticks): %s",
            len(short), MIN_ROUND_TICKS,
            [(s, e, e - s) for s, e, _, _ in short],
        )

    logger.info(
        "After filtering: %d rounds from %d starts / %d ends",
        len(pairs), len(start_ticks_sorted), len(end_rows),
    )

    # ---- Build round list --------------------------------------------------
    rounds: list[RoundInfo] = []
    for round_num, (start_tick, end_tick, winner, win_reason) in enumerate(pairs, 1):
        matching_freezes = [
            r for r in freeze_rows
            if start_tick <= r.get("tick", 0) <= end_tick
        ]
        freeze_end_tick = (
            int(matching_freezes[0]["tick"]) if matching_freezes else start_tick
        )

        rounds.append(RoundInfo(
            round_number=round_num,
            start_tick=start_tick,
            end_tick=end_tick,
            freeze_end_tick=freeze_end_tick,
            winner_team=winner,
            win_reason=win_reason,
            ct_score=0,
            t_score=0,
        ))

    # ---- Assign bomb ticks to rounds ---------------------------------------
    for df, attr in [
        (bomb_plants,   "bomb_planted_tick"),
        (bomb_defuses,  "bomb_defused_tick"),
        (bomb_explodes, "bomb_exploded_tick"),
    ]:
        for bomb_row in _rows(df):
            tick = int(bomb_row.get("tick", 0))
            for r in rounds:
                if r.start_tick <= tick <= r.end_tick:
                    setattr(r, attr, tick)
                    break

    # ---- Infer winner from bomb events where event data was missing ---------
    for r in rounds:
        if r.winner_team:
            continue
        if r.bomb_exploded_tick is not None:
            r.winner_team = "T"
            r.win_reason  = "1"   # target bombed
        elif r.bomb_defused_tick is not None:
            r.winner_team = "CT"
            r.win_reason  = "7"   # bomb defused

    # ---- Detect knife rounds -----------------------------------------------
    try:
        deaths_df  = parser.parse_event("player_death", other=["tick", "weapon"])
        death_rows = _rows(deaths_df)
    except Exception as exc:
        logger.warning("Could not parse player_death for knife detection: %s", exc)
        death_rows = []

    for r in rounds:
        kills = [
            d for d in death_rows
            if r.start_tick <= int(d.get("tick", 0)) <= r.end_tick
        ]
        if kills and all(
            str(d.get("weapon", "")).lower().startswith("knife")
            or str(d.get("weapon", "")).lower() == "knifegg"
            for d in kills
        ):
            r.is_knife_round = True

    # ---- Cumulative scores (always computed from winner; event fields unreliable)
    ct_wins = 0
    t_wins  = 0
    for r in rounds:
        if not r.is_knife_round:
            if r.winner_team == "CT":
                ct_wins += 1
            elif r.winner_team == "T":
                t_wins += 1
        r.ct_score = ct_wins
        r.t_score  = t_wins

    knife_count   = sum(1 for r in rounds if r.is_knife_round)
    winner_count  = sum(1 for r in rounds if r.winner_team)
    logger.info(
        "Extracted %d rounds (%d knife, %d display); winner data: %d/%d rounds",
        len(rounds),
        knife_count,
        len(rounds) - knife_count,
        winner_count,
        len(rounds),
    )

    # Per-round detail — helps diagnose extra/missing rounds
    for r in rounds:
        logger.info(
            "  final R%02d  ticks %d–%d  dur=%d (%.1fs)  winner=%-2s  "
            "reason=%-3s  knife=%s  score=%d:%d",
            r.round_number, r.start_tick, r.end_tick,
            r.end_tick - r.start_tick,
            (r.end_tick - r.start_tick) / tick_rate,
            r.winner_team or "--", r.win_reason or "--",
            "Y" if r.is_knife_round else "N",
            r.ct_score, r.t_score,
        )

    return rounds


def _extract_players(parser) -> list[PlayerInfo]:
    """Extract the player roster using parse_player_info (Polars-aware)."""
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

        players.append(PlayerInfo(
            player_id=steam_id,
            name=str(row.get("name", "") or ""),
            initial_team=team,
        ))

    return players


def _extract_positions(
    parser,
    rounds: list[RoundInfo],
    sample_rate: int,
    progress_cb: Callable[[float, str], None],
) -> list[PlayerPosition]:
    """Sample player positions every `sample_rate` ticks across all rounds."""
    if not rounds:
        return []

    all_ticks: list[int] = []
    for r in rounds:
        start = max(r.start_tick, r.freeze_end_tick)
        all_ticks.extend(range(start, r.end_tick + 1, sample_rate))

    if not all_ticks:
        return []

    progress_cb(0.25, f"Requesting {len(all_ticks):,} position ticks from parser")

    try:
        df = parser.parse_ticks(
            ["X", "Y", "Z", "team_num", "is_alive", "steamid"],
            ticks=all_ticks,
        )
    except Exception as exc:
        logger.error("Failed to parse position ticks: %s", exc)
        return []

    n_rows = len(df)
    progress_cb(0.60, f"Processing {n_rows:,} position rows")

    # Build tick → round lookup
    tick_to_round: dict[int, int] = {}
    for r in rounds:
        start = max(r.start_tick, r.freeze_end_tick)
        for t in range(start, r.end_tick + 1, sample_rate):
            tick_to_round[t] = r.round_number

    positions: list[PlayerPosition] = []
    records = _rows(df)

    for i, row in enumerate(records):
        if i % 50_000 == 0 and i > 0:
            progress_cb(
                0.60 + 0.28 * (i / n_rows),
                f"Processing positions {i:,}/{n_rows:,}",
            )

        raw_id = row.get("steamid", 0) or 0
        try:
            steam_id = int(raw_id)
        except (ValueError, TypeError):
            continue
        if steam_id == 0:
            continue

        tick = int(row.get("tick", 0) or 0)
        rn   = tick_to_round.get(tick, 0)
        if rn == 0:
            continue

        x = float(row.get("X", 0) or 0)
        y = float(row.get("Y", 0) or 0)
        z = float(row.get("Z", 0) or 0)
        if x == 0 and y == 0 and z == 0:
            continue  # player not yet spawned

        positions.append(PlayerPosition(
            tick=tick,
            round_number=rn,
            player_id=steam_id,
            x=x,
            y=y,
            z=z,
            team_num=int(row.get("team_num", 0) or 0),
            is_alive=bool(row.get("is_alive", False)),
        ))

    return positions


def _extract_events(parser, rounds: list[RoundInfo]) -> list[GameEvent]:
    """Extract kill and bomb events."""
    events: list[GameEvent] = []

    tick_to_round: dict[int, int] = {}
    for r in rounds:
        for t in range(r.start_tick, r.end_tick + 1):
            tick_to_round[t] = r.round_number

    def _rn(tick: int) -> int:
        return tick_to_round.get(tick, 0)

    # Kills
    try:
        kills_df = parser.parse_event(
            "player_death",
            other=["tick", "attacker_steamid", "user_steamid", "weapon", "headshot"],
        )
        for row in _rows(kills_df):
            tick = int(row.get("tick", 0) or 0)
            events.append(GameEvent(
                tick=tick,
                round_number=_rn(tick),
                event_type="player_death",
                attacker_id=int(row.get("attacker_steamid", 0) or 0) or None,
                victim_id=int(row.get("user_steamid", 0) or 0) or None,
                weapon=str(row.get("weapon", "") or ""),
                headshot=bool(row.get("headshot", False)),
            ))
    except Exception as exc:
        logger.warning("Could not parse player_death events: %s", exc)

    # Bomb events
    for event_name in ("bomb_planted", "bomb_defused", "bomb_exploded"):
        try:
            df = parser.parse_event(event_name, other=["tick"])
            for row in _rows(df):
                tick = int(row.get("tick", 0) or 0)
                events.append(GameEvent(
                    tick=tick,
                    round_number=_rn(tick),
                    event_type=event_name,
                ))
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    return sorted(events, key=lambda e: e.tick)
