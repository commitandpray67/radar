import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from parser.demo_parser import RoundInfo, _extract_positions


class DummyParser:
    def parse_ticks(self, _fields, ticks):
        return [
            {
                "tick": ticks[0],
                "steamid": 76561198000000000,
                "X": 100.0,
                "Y": 200.0,
                "Z": 10.0,
                "team_num": math.nan,
                "is_alive": True,
            }
        ]


def test_extract_positions_handles_nan_team_num() -> None:
    rounds = [
        RoundInfo(
            round_number=1,
            start_tick=100,
            end_tick=100,
            freeze_end_tick=100,
            winner_team="",
            win_reason="",
            ct_score=0,
            t_score=0,
        )
    ]

    progress_calls: list[tuple[float, str]] = []
    positions = _extract_positions(
        parser=DummyParser(),
        rounds=rounds,
        sample_rate=1,
        progress_cb=lambda frac, msg: progress_calls.append((frac, msg)),
    )

    assert len(positions) == 1
    assert positions[0].team_num == 0
    assert positions[0].player_id == 76561198000000000
