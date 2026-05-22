"""Player position sampling."""

from __future__ import annotations

import logging
from typing import Callable

from ._types import PlayerPosition, RoundInfo
from ._utils import _rows, _to_float, _to_int

logger = logging.getLogger(__name__)


def _extract_positions(
    parser,
    rounds: list[RoundInfo],
    sample_rate: int,
    progress_cb: Callable[[float, str], None],
) -> list[PlayerPosition]:
    """Sample player world-space positions every `sample_rate` ticks."""
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

    # Pre-build tick → round_number map using the sampled tick set.
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
