"""Tests for the pure scoreboard aggregation."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from analytics.scoreboard import compute_scoreboard


def _players(*ids):
    return [{"player_id": i, "name": f"p{i}", "initial_team": "CT" if i < 10 else "T"} for i in ids]


def _death(tick, rn, atk, vic, hs=False):
    return {"tick": tick, "round_number": rn, "attacker_id": atk, "victim_id": vic, "headshot": hs}


# Two CT (1,2) vs two T (10,11). tick_rate 64 → trade window 320 ticks.
SIDES = {
    1: {1: "CT", 2: "CT", 10: "T", 11: "T"},
    2: {1: "CT", 2: "CT", 10: "T", 11: "T"},
}
ROUNDS = [
    {"round_number": 1, "is_knife_round": False, "winner_team": "CT"},
    {"round_number": 2, "is_knife_round": False, "winner_team": "T"},
    {"round_number": 0, "is_knife_round": True, "winner_team": ""},  # knife → excluded
]


def _by_id(rows):
    return {r["player_id"]: r for r in rows}


def test_kills_deaths_headshots_and_opening():
    deaths = [
        _death(100, 1, 1, 10, hs=True),   # round 1 first blood: P1 kills P10 (HS)
        _death(200, 1, 2, 11),            # P2 kills P11
        _death(150, 2, 10, 1),            # round 2 first blood: P10 kills P1
    ]
    rows = _by_id(compute_scoreboard(ROUNDS, deaths, SIDES, _players(1, 2, 10, 11), 64.0))
    assert rows[1]["kills"] == 1 and rows[1]["hs_kills"] == 1 and rows[1]["deaths"] == 1
    assert rows[1]["hs_pct"] == 1.0
    # Opening: P1 got the round-1 opener (CT won → opening win); P10 got round-2 opener.
    assert rows[1]["opening_kills"] == 1 and rows[1]["opening_wins"] == 1
    # P10 got the round-2 opener AND was the round-1 opening victim.
    assert rows[10]["opening_kills"] == 1 and rows[10]["opening_deaths"] == 1
    assert rows[10]["opening_wins"] == 1  # T won round 2
    assert rows[1]["opening_deaths"] == 1  # died first in round 2


def test_knife_round_and_round_zero_excluded():
    deaths = [_death(50, 0, 1, 10)]  # knife round kill — must not count
    rows = _by_id(compute_scoreboard(ROUNDS, deaths, SIDES, _players(1, 10), 64.0))
    assert rows[1]["kills"] == 0


def test_teamkill_not_counted():
    deaths = [_death(100, 1, 1, 2)]  # P1 kills teammate P2
    rows = _by_id(compute_scoreboard(ROUNDS, deaths, SIDES, _players(1, 2), 64.0))
    assert rows[1]["kills"] == 0 and rows[2]["deaths"] == 1


def test_trade_within_window_and_boundary():
    # P10 kills P1; P2 avenges within 320 ticks → trade kill for P2, traded death for P1.
    deaths = [_death(100, 1, 10, 1), _death(400, 1, 2, 10)]  # gap 300 <= 320
    rows = _by_id(compute_scoreboard(ROUNDS, deaths, SIDES, _players(1, 2, 10), 64.0))
    assert rows[2]["trade_kills"] == 1
    assert rows[1]["traded_deaths"] == 1 and rows[1]["traded_death_pct"] == 1.0

    # Same but 1 tick outside the window → not a trade.
    deaths2 = [_death(100, 1, 10, 1), _death(421, 1, 2, 10)]  # gap 321 > 320
    rows2 = _by_id(compute_scoreboard(ROUNDS, deaths2, SIDES, _players(1, 2, 10), 64.0))
    assert rows2[2]["trade_kills"] == 0 and rows2[1]["traded_deaths"] == 0


def test_multikills_bucketed():
    deaths = [
        _death(100, 1, 1, 10),
        _death(200, 1, 1, 11),
        _death(300, 1, 1, 12),
    ]
    sides = {1: {1: "CT", 10: "T", 11: "T", 12: "T"}}
    rounds = [{"round_number": 1, "is_knife_round": False, "winner_team": "CT"}]
    rows = _by_id(compute_scoreboard(rounds, deaths, sides, _players(1, 10, 11, 12), 64.0))
    assert rows[1]["multikills"] == {"2": 0, "3": 1, "4": 0, "5": 0}


def test_kast_kill_survive_trade():
    # Round 1: P1 kills P10 (kill→KAST), P2 survives (survive→KAST), P11 dies untraded.
    deaths = [_death(100, 1, 1, 10), _death(200, 1, 10, 11)]
    rows = _by_id(compute_scoreboard(
        [{"round_number": 1, "is_knife_round": False, "winner_team": "CT"}],
        deaths, {1: {1: "CT", 2: "CT", 10: "T", 11: "T"}}, _players(1, 2, 10, 11), 64.0,
    ))
    assert rows[1]["kast"] == 1.0   # got a kill
    assert rows[2]["kast"] == 1.0   # survived
    assert rows[11]["kast"] == 0.0  # died, untraded, no kill


def test_damage_metrics_are_null():
    rows = compute_scoreboard(ROUNDS, [], SIDES, _players(1), 64.0)
    assert rows[0]["adr"] is None and rows[0]["assists"] is None
    assert rows[0]["has_damage_data"] is False
