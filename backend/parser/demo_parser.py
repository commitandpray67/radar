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

import bisect
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Callable

logger = logging.getLogger(__name__)

# Bump this when round-extraction logic changes so cached demos get re-parsed.
PARSER_VERSION = 23


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


def _to_int(value, default: int = 0) -> int:
    """Best-effort integer conversion that treats NaN/invalid values as default."""
    if value is None:
        return default
    try:
        if isinstance(value, float) and math.isnan(value):
            return default
    except TypeError:
        return default
    try:
        return int(value)
    except (ValueError, TypeError, OverflowError):
        return default


def _to_float(value, default: float = 0.0) -> float:
    """Best-effort float conversion that treats NaN/invalid values as default."""
    if value is None:
        return default
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError):
        return default
    if math.isnan(result):
        return default
    return result


def _coord(row: dict, *keys: str) -> float | None:
    """Return the first valid finite float found among the given keys, or None."""
    for key in keys:
        v = row.get(key)
        if v is None:
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if math.isnan(f) or math.isinf(f):
            continue
        return f
    return None


def _build_round_lookup(rounds: list):
    """Return an O(log n) tick→round_number lookup backed by bisect.

    Replaces the pattern of building a dict[tick, round_number] over every tick
    in every round's range, which wastes O(total_ticks) memory and time.
    """
    sorted_rounds = sorted(rounds, key=lambda r: r.start_tick)
    starts = [r.start_tick for r in sorted_rounds]
    ends   = [r.end_tick   for r in sorted_rounds]
    nums   = [r.round_number for r in sorted_rounds]

    def lookup(tick: int) -> int:
        idx = bisect.bisect_right(starts, tick) - 1
        if idx >= 0 and tick <= ends[idx]:
            return nums[idx]
        return 0

    return lookup


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
    ct_equip_value: int = 0   # CT team total equipment value at freeze_end
    t_equip_value: int = 0    # T team total equipment value at freeze_end


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
    yaw: float = 0.0          # view angle in degrees (0=East, 90=North in game coords)


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
class GrenadeEvent:
    round_number: int
    thrower_id: int           # SteamID64
    grenade_type: str         # 'he' | 'flash' | 'smoke' | 'molotov' | 'incendiary' | 'decoy'
    throw_tick: int
    detonate_tick: Optional[int] = None
    x: float = 0.0            # detonation world position
    y: float = 0.0
    z: float = 0.0
    expire_tick: Optional[int] = None  # when effect ends (smoke, fire)
    trajectory: list[dict] = field(default_factory=list)  # optional bounce points


@dataclass
class PlayerStateEvent:
    tick: int
    round_number: int
    player_id: int            # SteamID64
    event_type: str           # 'hurt' | 'equip' | 'spawn'
    hp: Optional[int] = None
    armor: Optional[int] = None
    weapon: Optional[str] = None


@dataclass
class ParsedDemo:
    match_info: MatchInfo
    rounds: list[RoundInfo] = field(default_factory=list)
    players: list[PlayerInfo] = field(default_factory=list)
    positions: list[PlayerPosition] = field(default_factory=list)
    events: list[GameEvent] = field(default_factory=list)
    grenades: list[GrenadeEvent] = field(default_factory=list)
    player_state_events: list[PlayerStateEvent] = field(default_factory=list)


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

    # ---- Grenades ------------------------------------------------------
    _progress(0.92, "Extracting grenade events")
    grenades = _extract_grenades(parser, rounds)

    # ---- Economy (equipment values at freeze end) ----------------------
    _progress(0.93, "Extracting economy data")
    rounds = _extract_economy(parser, rounds)

    # ---- Player state events (HP, armor, weapon equip) -----------------
    _progress(0.94, "Extracting player state events")
    player_state_events = _extract_player_state_events(parser, rounds)

    # ---- Correct initial_team from live position data ------------------
    # parse_player_info() reflects the CURRENT state which, after halftime,
    # means every player's team is the SWAPPED side.  We override initial_team
    # by examining team_num in the first non-knife round's positions — those
    # ticks are well past warmup and pre-halftime, so they reflect the actual
    # match-start side assignment.
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
    _round_end_errors: list[str] = []
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
            _round_end_errors.append(f"{event_name}: {exc}")
            logger.debug("Event %s unavailable: %s", event_name, exc)

    if not end_rows:
        logger.warning(
            "No round-end events found — demo may be from an unsupported CS2 build "
            "or the demoparser2 library needs updating. Errors: %s",
            "; ".join(_round_end_errors) or "none (events returned empty rows)",
        )

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
    _rn_lookup   = _build_round_lookup(rounds)
    rounds_by_rn = {r.round_number: r for r in rounds}
    for df, attr in [
        (bomb_plants,   "bomb_planted_tick"),
        (bomb_defuses,  "bomb_defused_tick"),
        (bomb_explodes, "bomb_exploded_tick"),
    ]:
        for bomb_row in _rows(df):
            tick = _to_int(bomb_row.get("tick", 0))
            rn   = _rn_lookup(tick)
            if rn:
                setattr(rounds_by_rn[rn], attr, tick)

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

    # Group deaths by round first (O(n)) instead of filtering per-round (O(n²))
    deaths_by_round: dict[int, list] = {}
    for d in death_rows:
        rn = _rn_lookup(_to_int(d.get("tick", 0)))
        if rn:
            deaths_by_round.setdefault(rn, []).append(d)

    for r in rounds:
        kills = deaths_by_round.get(r.round_number, [])
        if kills and all(
            (lambda w: w.startswith("knife") or w == "knifegg")(
                str(d.get("weapon", "")).lower().removeprefix("weapon_")
            )
            for d in kills
        ):
            r.is_knife_round = True

    # ---- Cumulative scores (team-based, accounts for side swap at halftime)
    # ct_score/t_score track the team that STARTED the game as CT/T respectively.
    # After halftime teams swap sides, so T-side wins count for the original CT team.
    non_knife = [r for r in rounds if not r.is_knife_round]
    # Halftime is always after the 12th non-knife round (MR12 standard).
    halftime_boundary = (
        non_knife[11].round_number if len(non_knife) > 12 else float("inf")
    )
    ct_wins = 0  # wins by the team that started as CT
    t_wins  = 0  # wins by the team that started as T
    for r in rounds:
        if not r.is_knife_round:
            in_first_half = r.round_number <= halftime_boundary
            if in_first_half:
                if r.winner_team == "CT":
                    ct_wins += 1
                elif r.winner_team == "T":
                    t_wins += 1
            else:
                # Sides swapped: T side = original CT team, CT side = original T team
                if r.winner_team == "T":
                    ct_wins += 1
                elif r.winner_team == "CT":
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


def _infer_initial_teams(
    positions: list,
    rounds: list[RoundInfo],
) -> dict[int, str]:
    """
    Return {player_id: initial_team} derived from position data in the first
    non-knife round.

    parse_player_info() returns the state at the END of the demo, which is
    AFTER halftime – so all teams are the opposite of their starting side.
    Position data carries team_num (2=T, 3=CT) at each sampled tick, which
    correctly reflects the in-game state at that moment.  The first non-knife
    round happens before any side-swap, so its team_num values are canonical.
    """
    if not positions or not rounds:
        return {}

    non_knife = [r for r in rounds if not r.is_knife_round]
    if not non_knife:
        return {}
    first_round = min(r.round_number for r in non_knife)

    team_map = {2: "T", 3: "CT"}
    result: dict[int, str] = {}
    for pos in positions:
        if pos.round_number == first_round and pos.player_id not in result:
            team = team_map.get(pos.team_num)
            if team:
                result[pos.player_id] = team
    return result


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

        team_num = _to_int(row.get("team_number", 0))
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
            ["X", "Y", "Z", "yaw", "team_num", "is_alive", "steamid"],
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

        tick = _to_int(row.get("tick", 0))
        rn   = tick_to_round.get(tick, 0)
        if rn == 0:
            continue

        x = _to_float(row.get("X", 0) or 0)
        y = _to_float(row.get("Y", 0) or 0)
        z = _to_float(row.get("Z", 0) or 0)
        if x == 0 and y == 0 and z == 0:
            continue  # player not yet spawned

        positions.append(PlayerPosition(
            tick=tick,
            round_number=rn,
            player_id=steam_id,
            x=x,
            y=y,
            z=z,
            team_num=_to_int(row.get("team_num", 0)),
            is_alive=bool(row.get("is_alive", False)),
            yaw=_to_float(row.get("yaw"), 0.0),
        ))

    return positions


def _extract_events(parser, rounds: list[RoundInfo]) -> list[GameEvent]:
    """Extract kill and bomb events."""
    events: list[GameEvent] = []

    _rn = _build_round_lookup(rounds)

    # Kills
    try:
        kills_df = parser.parse_event(
            "player_death",
            other=["tick", "attacker_steamid", "user_steamid", "weapon", "headshot"],
        )
        for row in _rows(kills_df):
            tick = _to_int(row.get("tick", 0))
            events.append(GameEvent(
                tick=tick,
                round_number=_rn(tick),
                event_type="player_death",
                attacker_id=_to_int(row.get("attacker_steamid", 0)) or None,
                victim_id=_to_int(row.get("user_steamid", 0)) or None,
                weapon=str(row.get("weapon", "") or ""),
                headshot=bool(row.get("headshot", False)),
            ))
    except Exception as exc:
        logger.warning("Could not parse player_death events: %s", exc)

    # Bomb events
    for event_name in ("bomb_planted", "bomb_defused", "bomb_exploded"):
        try:
            extra = ["tick", "site"] if event_name == "bomb_planted" else ["tick"]
            df = parser.parse_event(event_name, other=extra)
            for row in _rows(df):
                tick = _to_int(row.get("tick", 0))
                weapon: str | None = None
                if event_name == "bomb_planted":
                    site_raw = row.get("site", row.get("bombsite", None))
                    if site_raw is not None:
                        weapon = "A" if int(site_raw) == 0 else "B"
                events.append(GameEvent(
                    tick=tick,
                    round_number=_rn(tick),
                    event_type=event_name,
                    weapon=weapon,
                ))
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    return sorted(events, key=lambda e: e.tick)


# ---------------------------------------------------------------------------
# Grenade extraction
# ---------------------------------------------------------------------------

# Grenade-type weapon names (CS2 uses both with and without "weapon_" prefix)
_GRENADE_WEAPONS: dict[str, str] = {
    "hegrenade": "he",          "weapon_hegrenade": "he",
    "flashbang": "flash",       "weapon_flashbang": "flash",
    "smokegrenade": "smoke",    "weapon_smokegrenade": "smoke",
    "molotov": "molotov",       "weapon_molotov": "molotov",
    "incgrenade": "incendiary", "weapon_incgrenade": "incendiary",
    "decoy": "decoy",           "weapon_decoy": "decoy",
}

# Detonation event name → normalised grenade type
_DETONATE_EVENTS: dict[str, str] = {
    "hegrenade_detonate": "he",
    "flashbang_detonate": "flash",
    "smokegrenade_detonate": "smoke",
    "molotov_detonate": "molotov",
    "inferno_startburn": "molotov",   # covers both molotov & incendiary
}

# Normalise the grenade_type strings returned by parse_grenades() to our schema.
# parse_grenades() returns CS2 entity class names ("CHEGrenadeProjectile", etc.)
# which we normalise to lowercase with spaces/underscores stripped.
_TRAJ_TYPE_MAP: dict[str, str] = {
    # Short names (older demoparser2 / CS:GO)
    "hegrenade": "he",
    "flashbang": "flash",
    "smokegrenade": "smoke",
    "molotov": "molotov",
    "molotovgrenade": "molotov",
    "incendiarygrenade": "incendiary",
    "incendiary": "incendiary",
    "decoygrenade": "decoy",
    "decoy": "decoy",
    # CS2 entity class names as returned by demoparser2
    "chegrenadeprojectile": "he",
    "cflashbangprojectile": "flash",
    "csmokegrenadeprojectile": "smoke",
    "cmolotovprojectile": "molotov",
    "cincendiaryprojectile": "incendiary",
    "cdecoyprojectile": "decoy",
    "cdecoyprojector": "decoy",
}

# Substring fallback for entity class names (order matters — most specific first)
_TRAJ_SUBSTR_FALLBACK: list[tuple[str, str]] = [
    ("hegrenade", "he"),
    ("flashbang", "flash"),
    ("smokegrenade", "smoke"),
    ("smoke", "smoke"),
    ("molotov", "molotov"),
    ("incendiary", "incendiary"),
    ("decoy", "decoy"),
]


def _map_grenade_type(raw: str) -> str | None:
    """Map a raw grenade_type string from parse_grenades() to our schema type."""
    key = raw.lower().replace(" ", "").replace("_", "")
    result = _TRAJ_TYPE_MAP.get(key)
    if result is not None:
        return result
    # Substring fallback
    for substr, gtype in _TRAJ_SUBSTR_FALLBACK:
        if substr in key:
            return gtype
    return None

# Effect duration in ticks (64-tick default; scaled if tick_rate differs)
_EFFECT_TICKS: dict[str, int] = {
    "he": 64,          # ~1 s brief flash
    "flash": 48,
    "smoke": 1152,     # ~18 s
    "molotov": 448,    # ~7 s
    "incendiary": 448,
    "decoy": 256,      # ~4 s
}


def _extract_grenades(parser, rounds: list[RoundInfo]) -> list[GrenadeEvent]:
    """Match weapon_fire (throw) events to grenade detonation events."""
    _rn = _build_round_lookup(rounds)

    # -- Throws (weapon_fire filtered to grenade weapon types) --
    throws: list[dict] = []
    try:
        fire_df = parser.parse_event(
            "weapon_fire",
            other=["tick", "weapon", "user_steamid"],
        )
        for row in _rows(fire_df):
            weapon = str(row.get("weapon", "") or "").lower()
            nade_type = _GRENADE_WEAPONS.get(weapon)
            if nade_type is None:
                continue
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue
            thrower_id = _to_int(row.get("user_steamid", 0))
            throws.append({"tick": tick, "round_number": rn,
                           "thrower_id": thrower_id, "grenade_type": nade_type})
    except Exception as exc:
        logger.warning("Could not parse weapon_fire for grenades: %s", exc)

    # -- Detonations --
    detonations: list[dict] = []
    for event_name, nade_type in _DETONATE_EVENTS.items():
        try:
            det_df = parser.parse_event(
                event_name,
                other=["tick", "x", "y", "z", "user_steamid"],
            )
            for row in _rows(det_df):
                tick = _to_int(row.get("tick", 0))
                rn = _rn(tick)
                if rn == 0:
                    continue
                # demoparser2 may return uppercase or lowercase coordinate keys;
                # skip rows where x or y is missing/NaN — they would map to (0,0)
                x = _coord(row, "x", "X")
                y = _coord(row, "y", "Y")
                if x is None or y is None:
                    continue
                z = _coord(row, "z", "Z") or 0.0
                thrower_id = _to_int(row.get("user_steamid", 0))
                detonations.append({
                    "tick": tick, "round_number": rn,
                    "grenade_type": nade_type,
                    "x": x, "y": y, "z": z,
                    "thrower_id": thrower_id,
                })
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    # -- Expire events (smoke / fire end) --
    # Stored as lists per round for distance-based lookup (more robust than
    # fixed-grid rounding which fails when coords differ by >10 units).
    expire_list: dict[int, list[dict]] = {}
    for event_name in ("smokegrenade_expired", "inferno_expire"):
        try:
            exp_df = parser.parse_event(event_name, other=["tick", "x", "y"])
            for row in _rows(exp_df):
                tick = _to_int(row.get("tick", 0))
                rn = _rn(tick)
                if rn == 0:
                    continue
                x = _coord(row, "x", "X")
                y = _coord(row, "y", "Y")
                if x is None or y is None:
                    continue
                expire_list.setdefault(rn, []).append({"tick": tick, "x": x, "y": y})
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    # -- Full per-tick trajectory from parse_grenades() --
    # parse_grenades() returns the grenade entity position at every tick of its
    # existence (including pre-throw "inventory" ticks at Z≈−5120).  We collect
    # all rows and later filter each GrenadeEvent to its exact flight window
    # [throw_tick, detonate_tick] — no instance-grouping needed.
    raw_traj: list[dict] = []
    try:
        import math as _math
        traj_df = parser.parse_grenades()
        # Log a sample of raw grenade_type values to diagnose mapping issues
        _seen_raw_types: set[str] = set()
        for row in _rows(traj_df):
            raw_type = str(row.get("grenade_type", "") or "")
            _seen_raw_types.add(raw_type)
            gtype = _map_grenade_type(raw_type)
            if gtype is None:
                continue
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue

            # Validate coordinates — demoparser2 emits NaN for ticks where the
            # entity position hasn't been updated.  NaN is truthy so `val or 0`
            # returns NaN unchanged; we must check explicitly and skip bad rows.
            def _fv(key_upper, key_lower):
                v = row.get(key_upper)
                if v is None:
                    v = row.get(key_lower)
                if v is None:
                    return None
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    return None
                return None if _math.isnan(f) or _math.isinf(f) else f

            x = _fv("X", "x")
            y = _fv("Y", "y")
            z_val = _fv("Z", "z")
            if x is None or y is None:
                continue  # skip rows without valid 2-D coordinates
            z = z_val if z_val is not None else 0.0

            # Skip "parked" positions (grenade entity stored below map while in inventory)
            if z < -4096:
                continue
            raw_sid = row.get("thrower_steamid")
            try:
                thrower_id = (0 if raw_sid is None
                              or (isinstance(raw_sid, float) and _math.isnan(raw_sid))
                              else int(float(raw_sid)))
            except Exception:
                thrower_id = 0
            raw_traj.append({
                "gtype": gtype, "tick": tick, "rn": rn,
                "x": x, "y": y, "z": z,
                "thrower_id": thrower_id,
            })
        logger.info(
            "parse_grenades() raw grenade_type values seen: %s",
            sorted(_seen_raw_types),
        )
        logger.info("parse_grenades() yielded %d usable rows", len(raw_traj))
    except Exception as exc:
        logger.warning("Could not extract grenade trajectories via parse_grenades(): %s", exc)

    # -- Match throws to detonations --
    MAX_FLIGHT_TICKS = 448   # ~7 s max flight time
    used_det: set[int] = set()
    grenades: list[GrenadeEvent] = []

    # Pre-group detonations by round so the inner loop only scans same-round
    # candidates instead of iterating the entire detonation list per throw.
    dets_by_round: dict[int, list[tuple[int, dict]]] = {}
    for _i, _det in enumerate(detonations):
        dets_by_round.setdefault(_det["round_number"], []).append((_i, _det))

    for throw in sorted(throws, key=lambda t: t["tick"]):
        best_idx: int | None = None
        best_diff = MAX_FLIGHT_TICKS + 1

        for i, det in dets_by_round.get(throw["round_number"], []):
            if i in used_det:
                continue
            # Type compatibility: incendiary throw → molotov detonate (same event)
            nt = throw["grenade_type"]
            dt = det["grenade_type"]
            if nt != dt and not (nt in ("molotov", "incendiary") and dt == "molotov"):
                continue
            diff = det["tick"] - throw["tick"]
            if diff < 0 or diff > MAX_FLIGHT_TICKS:
                continue
            # Prefer exact thrower match when both sides have the ID
            if det["thrower_id"] and throw["thrower_id"]:
                if det["thrower_id"] != throw["thrower_id"]:
                    continue
            if diff < best_diff:
                best_diff = diff
                best_idx = i

        if best_idx is None:
            # No detonation found — store throw only
            grenades.append(GrenadeEvent(
                round_number=throw["round_number"],
                thrower_id=throw["thrower_id"],
                grenade_type=throw["grenade_type"],
                throw_tick=throw["tick"],
            ))
            continue

        used_det.add(best_idx)
        det = detonations[best_idx]
        nade_type = throw["grenade_type"]

        # Find expire tick via nearest-neighbour position search.
        # Use 200-unit radius to handle coordinate drift between events.
        expire_tick: int | None = None
        _EXPIRE_MATCH_DIST_SQ = 200 ** 2
        for candidate in expire_list.get(det["round_number"], []):
            dx = candidate["x"] - det["x"]
            dy = candidate["y"] - det["y"]
            if dx * dx + dy * dy <= _EXPIRE_MATCH_DIST_SQ:
                if expire_tick is None or candidate["tick"] < expire_tick:
                    expire_tick = candidate["tick"]
        if expire_tick is None:
            duration = _EFFECT_TICKS.get(nade_type, 64)
            expire_tick = det["tick"] + duration

        grenades.append(GrenadeEvent(
            round_number=throw["round_number"],
            thrower_id=throw["thrower_id"],
            grenade_type=nade_type,
            throw_tick=throw["tick"],
            detonate_tick=det["tick"],
            x=det["x"],
            y=det["y"],
            z=det["z"],
            expire_tick=expire_tick,
            trajectory=[],  # filled in post-processing below
        ))

    # -- Attach trajectory waypoints to each grenade --
    if raw_traj:
        MAX_TRAJ_WP = 48
        import math as _imath
        from collections import defaultdict as _dd

        # ── Step 1: separate raw rows into per-entity tracks ──────────────────
        # parse_grenades() returns multiple rows per tick when several grenades
        # of the same type fly simultaneously.  A simple tick-deduplicate (keep
        # one per tick) arbitrarily discards real data.  Instead we use greedy
        # nearest-neighbour multi-object tracking to group rows by entity.
        #
        # Within each (gtype, round_number) bucket we maintain a set of
        # "active tracks".  Each incoming row is assigned to the track whose
        # last known position is closest (and within MATCH_DIST units); if none
        # qualifies a new track is started.  Tracks not updated for > GAP ticks
        # are retired.

        MATCH_DIST_SQ = 500 ** 2   # max sq-distance to continue a track
        TRACK_GAP     = 16          # retire a track after this many idle ticks

        def _build_tracks(bucket_sorted: list[dict]) -> list[list[dict]]:
            active: list[dict] = []   # {pts, last_x, last_y, last_tick}
            finished: list[list[dict]] = []

            for row in bucket_sorted:
                tick = row["tick"]
                x, y = row["x"], row["y"]

                # Retire stale tracks
                live, stale = [], []
                for t in active:
                    (live if tick - t["last_tick"] <= TRACK_GAP else stale).append(t)
                for t in stale:
                    finished.append(t["pts"])
                active = live

                # Greedy nearest-neighbour match (one row consumed per track)
                best_i, best_dsq = None, MATCH_DIST_SQ
                for i, t in enumerate(active):
                    dsq = (x - t["last_x"]) ** 2 + (y - t["last_y"]) ** 2
                    if dsq < best_dsq:
                        best_dsq = dsq
                        best_i = i

                if best_i is not None:
                    t = active[best_i]
                    t["pts"].append(row)
                    t["last_x"], t["last_y"], t["last_tick"] = x, y, tick
                else:
                    active.append({"pts": [row], "last_x": x,
                                   "last_y": y, "last_tick": tick})

            for t in active:
                finished.append(t["pts"])
            return [pts for pts in finished if len(pts) >= 2]

        # Build track index: (gtype, rn) → list of entity tracks
        raw_by_key: dict[tuple, list[dict]] = _dd(list)
        for r in raw_traj:
            raw_by_key[(r["gtype"], r["rn"])].append(r)

        track_index: dict[tuple, list[list[dict]]] = {}
        for key, bucket in raw_by_key.items():
            bucket.sort(key=lambda r: r["tick"])
            track_index[key] = _build_tracks(bucket)

        # ── Step 2: assign best-matching track to each grenade ────────────────
        for g in grenades:
            if g.detonate_tick is None:
                continue
            all_tracks = track_index.get((g.grenade_type, g.round_number), [])
            if not all_tracks:
                continue

            # Filter tracks to those with ≥2 points inside the flight window,
            # optionally filtered by thrower_id when available.
            candidates: list[list[dict]] = []
            for track in all_tracks:
                window = [
                    r for r in track
                    if g.throw_tick <= r["tick"] <= g.detonate_tick
                    and not (r["thrower_id"] and g.thrower_id
                             and r["thrower_id"] != g.thrower_id)
                ]
                if len(window) >= 2:
                    candidates.append(window)

            if not candidates:
                continue

            # Pick the candidate whose last point is nearest to the detonation
            best = min(
                candidates,
                key=lambda pts: (
                    (pts[-1]["x"] - g.x) ** 2 + (pts[-1]["y"] - g.y) ** 2
                ),
            )

            # Sample evenly, always keeping first and last
            step = max(1, len(best) // MAX_TRAJ_WP)
            sampled = best[::step]
            if sampled[-1] is not best[-1]:
                sampled.append(best[-1])

            g.trajectory = [
                {"tick": r["tick"], "x": r["x"], "y": r["y"], "z": r["z"]}
                for r in sampled
            ]

        attached = sum(1 for g in grenades if g.trajectory)
        logger.info("Attached trajectories to %d/%d grenades", attached, len(grenades))

    logger.info("Extracted %d grenade events", len(grenades))
    return grenades


# ---------------------------------------------------------------------------
# Economy extraction
# ---------------------------------------------------------------------------

def _extract_economy(parser, rounds: list[RoundInfo]) -> list[RoundInfo]:
    """
    Fill ct_equip_value / t_equip_value on each RoundInfo by reading
    current_equip_value at the freeze_end_tick of each round.
    """
    if not rounds:
        return rounds

    freeze_ticks = [r.freeze_end_tick for r in rounds if r.freeze_end_tick > 0]
    if not freeze_ticks:
        return rounds

    try:
        df = parser.parse_ticks(
            ["current_equip_value", "team_num", "steamid"],
            ticks=freeze_ticks,
        )
    except Exception as exc:
        logger.warning("Could not extract economy data: %s", exc)
        return rounds

    # Build {freeze_end_tick: {team_num: total_value}} mapping
    from collections import defaultdict
    economy: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))

    for row in _rows(df):
        tick = _to_int(row.get("tick", 0))
        team = _to_int(row.get("team_num", 0))
        val = _to_int(row.get("current_equip_value", 0))
        if team in (2, 3) and val > 0:
            economy[tick][team] += val

    for r in rounds:
        snap = economy.get(r.freeze_end_tick, {})
        r.ct_equip_value = snap.get(3, 0)  # team_num 3 = CT
        r.t_equip_value  = snap.get(2, 0)  # team_num 2 = T

    logger.info("Economy extracted for %d rounds", len(rounds))
    return rounds


# ---------------------------------------------------------------------------
# Player state event extraction
# ---------------------------------------------------------------------------

def _extract_player_state_events(
    parser, rounds: list[RoundInfo]
) -> list[PlayerStateEvent]:
    """Extract HP/armor changes (player_hurt) and weapon equip events."""
    _rn = _build_round_lookup(rounds)

    def _event_player_id(row: dict) -> int:
        for key in ("user_steamid", "steamid", "player_steamid"):
            raw = row.get(key, 0) or 0
            try:
                pid = int(raw)
            except (TypeError, ValueError):
                continue
            if pid > 0:
                return pid
        return 0

    state_events: list[PlayerStateEvent] = []

    def _optional_nonnegative_int(value: object) -> Optional[int]:
        """Parse an event numeric field without collapsing missing values to 0."""
        if value is None:
            return None
        if isinstance(value, str) and value.strip() == "":
            return None
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        return max(0, parsed)

    def _row_hp(row: dict, default: object = None) -> Optional[int]:
        return _optional_nonnegative_int(
            row.get("hp", row.get("health", row.get("user_health", default)))
        )

    def _row_armor(row: dict) -> Optional[int]:
        return _optional_nonnegative_int(
            row.get("armor", row.get("armor_value", row.get("user_armor")))
        )

    # -- player_hurt: records victim HP/armor after taking damage --
    try:
        hurt_df = parser.parse_event(
            "player_hurt",
            other=["tick", "user_steamid", "hp", "armor", "weapon"],
        )
        for row in _rows(hurt_df):
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue
            player_id = _event_player_id(row)
            if player_id == 0:
                continue
            state_events.append(PlayerStateEvent(
                tick=tick,
                round_number=rn,
                player_id=player_id,
                event_type="hurt",
                hp=_row_hp(row),
                armor=_row_armor(row),
                weapon=str(row.get("weapon", "") or ""),
            ))
    except Exception as exc:
        logger.warning("Could not parse player_hurt: %s", exc)

    # -- item_equip: tracks currently held weapon --
    try:
        equip_df = parser.parse_event(
            "item_equip",
            other=["tick", "user_steamid", "item"],
        )
        for row in _rows(equip_df):
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue
            player_id = _event_player_id(row)
            if player_id == 0:
                continue
            item = str(row.get("item", "") or "")
            if not item:
                continue
            state_events.append(PlayerStateEvent(
                tick=tick,
                round_number=rn,
                player_id=player_id,
                event_type="equip",
                weapon=item,
            ))
    except Exception as exc:
        logger.warning("Could not parse item_equip: %s", exc)

    # -- item_pickup: helps reconstruct grenade / loadout ownership --
    try:
        pickup_df = parser.parse_event(
            "item_pickup",
            other=["tick", "user_steamid", "item"],
        )
        for row in _rows(pickup_df):
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue
            player_id = _event_player_id(row)
            if player_id == 0:
                continue
            item = str(row.get("item", "") or "")
            if not item:
                continue
            state_events.append(PlayerStateEvent(
                tick=tick,
                round_number=rn,
                player_id=player_id,
                event_type="equip",
                weapon=item,
            ))
    except Exception as exc:
        logger.debug("Could not parse item_pickup: %s", exc)

    # -- item_purchase: captures armor and bought pistols/primaries --
    try:
        purchase_df = parser.parse_event(
            "item_purchase",
            other=["tick", "user_steamid", "weapon", "item"],
        )
        for row in _rows(purchase_df):
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue
            player_id = _event_player_id(row)
            if player_id == 0:
                continue
            weapon = str(row.get("weapon", row.get("item", "")) or "")
            if not weapon:
                continue
            state_events.append(PlayerStateEvent(
                tick=tick,
                round_number=rn,
                player_id=player_id,
                event_type="equip",
                weapon=weapon,
            ))
    except Exception as exc:
        logger.debug("Could not parse item_purchase: %s", exc)

    # -- player_spawn: reset HP/armor to round-start values --
    try:
        spawn_df = parser.parse_event(
            "player_spawn",
            other=["tick", "user_steamid", "health", "hp", "armor", "armor_value"],
        )
        for row in _rows(spawn_df):
            tick = _to_int(row.get("tick", 0))
            rn = _rn(tick)
            if rn == 0:
                continue
            player_id = _event_player_id(row)
            if player_id == 0:
                continue
            state_events.append(PlayerStateEvent(
                tick=tick,
                round_number=rn,
                player_id=player_id,
                event_type="spawn",
                hp=_row_hp(row, 100),
                armor=_row_armor(row),
            ))
    except Exception as exc:
        logger.debug("Could not parse player_spawn: %s", exc)

    # -- Tick-based fallback at freeze_end: captures true round-start hp/armor --
    try:
        freeze_ticks = sorted({r.freeze_end_tick for r in rounds})
        if freeze_ticks:
            tick_df = parser.parse_ticks(
                ["steamid", "health", "hp", "armor", "armor_value"],
                ticks=freeze_ticks,
            )
            for row in _rows(tick_df):
                tick = _to_int(row.get("tick", 0))
                rn = _rn(tick)
                if rn == 0:
                    continue
                player_id = _event_player_id(row)
                if player_id == 0:
                    continue
                hp = _row_hp(row)
                armor = _row_armor(row)
                if hp is None and armor is None:
                    continue
                state_events.append(PlayerStateEvent(
                    tick=tick,
                    round_number=rn,
                    player_id=player_id,
                    event_type="spawn",
                    hp=hp,
                    armor=armor,
                ))
    except Exception as exc:
        logger.debug("Could not parse freeze_end tick state: %s", exc)

    logger.info("Extracted %d player state events", len(state_events))
    return sorted(state_events, key=lambda e: e.tick)
