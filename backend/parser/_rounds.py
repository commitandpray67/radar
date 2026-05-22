"""Round extraction from a CS2 demo."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ._types import RoundInfo
from ._utils import _build_round_lookup, _rows, _to_int

if TYPE_CHECKING:
    from ._types import PlayerPosition

logger = logging.getLogger(__name__)


def _parse_winner(raw) -> str:
    """Normalise a round-end winner field to 'CT', 'T', or ''."""
    s = str(raw or "").strip().upper()
    if s in ("2", "T", "TERRORIST"):
        return "T"
    if s in ("3", "CT", "COUNTERTERRORIST"):
        return "CT"
    return ""


def _extract_rounds(parser, tick_rate: float = 64.0) -> list[RoundInfo]:
    """
    Build RoundInfo list from round events.

    Strategy:
      1. Pair every round_end with its immediately-preceding round_start
         (each event consumed at most once → orphaned starts are discarded).
      2. Remove transition rounds via reason=16 (GameStart — warmup→match,
         first-half→second-half transitions).
      3. Short-duration fallback (< 13 s) catches any remaining non-game rounds.
    """
    MIN_ROUND_TICKS = int(13 * tick_rate)

    # ---- round_start -------------------------------------------------------
    try:
        round_starts_raw = parser.parse_event("round_start", other=["tick"])
    except Exception as exc:
        logger.warning("Could not parse round_start: %s", exc)
        return []

    start_rows = sorted(_rows(round_starts_raw), key=lambda r: r.get("tick", 0))
    if not start_rows:
        return []

    # ---- round_end (try round_end first, then round_officially_ended) ------
    end_rows: list[dict] = []
    _errors: list[str] = []
    for event_name in ("round_end", "round_officially_ended"):
        try:
            df   = parser.parse_event(event_name, other=["tick", "winner", "reason"])
            rows = _rows(df)
            if rows:
                end_rows = sorted(rows, key=lambda r: r.get("tick", 0))
                logger.info("Round-end source: %s (%d events)", event_name, len(rows))
                break
        except Exception as exc:
            _errors.append(f"{event_name}: {exc}")
            logger.debug("Event %s unavailable: %s", event_name, exc)

    if not end_rows:
        logger.warning(
            "No round-end events found — demo may be from an unsupported CS2 build "
            "or demoparser2 needs updating. Errors: %s",
            "; ".join(_errors) or "none",
        )

    # ---- freeze-end and bomb events ----------------------------------------
    def _safe(name, other):
        try:
            return parser.parse_event(name, other=other)
        except Exception:
            return []

    freeze_ends   = _safe("round_freeze_end", ["tick"])
    bomb_plants   = _safe("bomb_planted",     ["tick"])
    bomb_defuses  = _safe("bomb_defused",     ["tick"])
    bomb_explodes = _safe("bomb_exploded",    ["tick"])

    freeze_rows = sorted(_rows(freeze_ends), key=lambda r: r.get("tick", 0))

    logger.info(
        "Raw events: %d round_start, %d round_end, %d freeze_end",
        len(start_rows), len(end_rows), len(freeze_rows),
    )

    # ---- Pair each round_end with its closest preceding unused round_start -
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

    for i, (s, e, w, rsn) in enumerate(pairs, 1):
        logger.info(
            "  raw R%02d  ticks %d–%d  dur=%d (%.1fs)  winner=%-2s  reason=%s",
            i, s, e, e - s, (e - s) / tick_rate, w or "--", rsn or "--",
        )

    # ---- Filter 1: reason-code filter (16 = GameStart transition) ----------
    TRANSITION_REASONS = {"16"}
    transition = [(s, e, w, r) for s, e, w, r in pairs if r in TRANSITION_REASONS]
    pairs      = [(s, e, w, r) for s, e, w, r in pairs if r not in TRANSITION_REASONS]
    if transition:
        logger.info(
            "Removed %d transition round(s) by reason=16: %s",
            len(transition), [(s, e, rsn) for s, e, _, rsn in transition],
        )

    # ---- Filter 2: short-duration fallback ---------------------------------
    short = [(s, e, w, r) for s, e, w, r in pairs if e - s < MIN_ROUND_TICKS]
    pairs = [(s, e, w, r) for s, e, w, r in pairs if e - s >= MIN_ROUND_TICKS]
    if short:
        logger.info(
            "Removed %d short round(s) (< %d ticks): %s",
            len(short), MIN_ROUND_TICKS, [(s, e, e - s) for s, e, _, _ in short],
        )

    logger.info(
        "After filtering: %d rounds from %d starts / %d ends",
        len(pairs), len(start_ticks_sorted), len(end_rows),
    )

    # ---- Build RoundInfo list ----------------------------------------------
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

    # ---- Assign bomb ticks -------------------------------------------------
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

    # ---- Infer winner from bomb events when event data was missing ----------
    for r in rounds:
        if r.winner_team:
            continue
        if r.bomb_exploded_tick is not None:
            r.winner_team = "T"
            r.win_reason  = "1"
        elif r.bomb_defused_tick is not None:
            r.winner_team = "CT"
            r.win_reason  = "7"

    # ---- Knife-round detection ---------------------------------------------
    try:
        deaths_df  = parser.parse_event("player_death", other=["tick", "weapon"])
        death_rows = _rows(deaths_df)
    except Exception as exc:
        logger.warning("Could not parse player_death for knife detection: %s", exc)
        death_rows = []

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

    # ---- Cumulative scores (accounts for halftime side swap) ---------------
    # ct_score/t_score track the team that STARTED the game as CT/T throughout
    # — after halftime their roles reverse so we flip attribution accordingly.
    non_knife = [r for r in rounds if not r.is_knife_round]
    halftime_boundary = (
        non_knife[11].round_number if len(non_knife) > 12 else float("inf")
    )
    ct_wins = t_wins = 0
    for r in rounds:
        if not r.is_knife_round:
            in_first_half = r.round_number <= halftime_boundary
            if in_first_half:
                if r.winner_team == "CT":
                    ct_wins += 1
                elif r.winner_team == "T":
                    t_wins += 1
            else:
                if r.winner_team == "T":
                    ct_wins += 1
                elif r.winner_team == "CT":
                    t_wins += 1
        r.ct_score = ct_wins
        r.t_score  = t_wins

    knife_count  = sum(1 for r in rounds if r.is_knife_round)
    winner_count = sum(1 for r in rounds if r.winner_team)
    logger.info(
        "Extracted %d rounds (%d knife, %d display); winner data: %d/%d",
        len(rounds), knife_count, len(rounds) - knife_count, winner_count, len(rounds),
    )
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
    positions: list[PlayerPosition],
    rounds: list[RoundInfo],
) -> dict[int, str]:
    """
    Return {player_id: team} derived from positions in the first non-knife round.

    parse_player_info() reflects the state at the END of the demo (after
    halftime), so all teams are the wrong side.  Position data carries
    team_num at each sampled tick which is correct at that moment.
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
