"""Low-level helpers shared across all parser sub-modules."""

from __future__ import annotations

import bisect
import math
from collections.abc import Callable


def _rows(df) -> list[dict]:
    """Return rows as a list of dicts.

    Handles Polars DataFrames, Pandas DataFrames, and plain Python lists
    (demoparser2 v0.41 returns a list for some events with no data).
    """
    if isinstance(df, list):
        return df
    try:
        return df.rows(named=True)  # Polars DataFrame
    except AttributeError:
        return df.to_dict("records")  # Pandas DataFrame


def _is_empty(df) -> bool:
    """Return True if the result has no rows."""
    if isinstance(df, list):
        return len(df) == 0
    try:
        return df.is_empty()  # Polars
    except AttributeError:
        return len(df) == 0  # Pandas / anything with len()


def _to_int(value, default: int = 0) -> int:
    """Best-effort int conversion — treats NaN/invalid as default."""
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
    """Best-effort float conversion — treats NaN/invalid as default."""
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


def _build_round_lookup(rounds: list) -> Callable[[int], int]:
    """Return an O(log n) tick→round_number lookup backed by bisect.

    Replaces the O(total_ticks) dict-based approach that wastes memory by
    storing every tick in every round's range.
    """
    sorted_rounds = sorted(rounds, key=lambda r: r.start_tick)
    starts = [r.start_tick for r in sorted_rounds]
    ends = [r.end_tick for r in sorted_rounds]
    nums = [r.round_number for r in sorted_rounds]

    def lookup(tick: int) -> int:
        idx = bisect.bisect_right(starts, tick) - 1
        if idx >= 0 and tick <= ends[idx]:
            return nums[idx]
        return 0

    return lookup
