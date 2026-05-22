"""Normalised data types produced by the CS2 demo parser."""

from __future__ import annotations

from dataclasses import dataclass, field


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
    winner_team: str  # "CT" | "T" | ""
    win_reason: str
    ct_score: int
    t_score: int
    bomb_planted_tick: int | None = None
    bomb_defused_tick: int | None = None
    bomb_exploded_tick: int | None = None
    is_knife_round: bool = False
    ct_equip_value: int = 0  # CT team total equipment value at freeze_end
    t_equip_value: int = 0  # T  team total equipment value at freeze_end


@dataclass
class PlayerInfo:
    player_id: int  # SteamID64
    name: str
    initial_team: str  # "CT" | "T" | "Spectator"


@dataclass
class PlayerPosition:
    tick: int
    round_number: int
    player_id: int
    x: float
    y: float
    z: float
    team_num: int  # 2 = T, 3 = CT
    is_alive: bool
    yaw: float = 0.0  # view angle in degrees (0=East, 90=North in game coords)


@dataclass
class GameEvent:
    tick: int
    round_number: int
    event_type: str
    attacker_id: int | None = None
    victim_id: int | None = None
    weapon: str | None = None
    headshot: bool = False


@dataclass
class GrenadeEvent:
    round_number: int
    thrower_id: int  # SteamID64
    grenade_type: str  # 'he' | 'flash' | 'smoke' | 'molotov' | 'incendiary' | 'decoy'
    throw_tick: int
    detonate_tick: int | None = None
    x: float = 0.0  # detonation world position
    y: float = 0.0
    z: float = 0.0
    expire_tick: int | None = None  # when effect ends (smoke, fire)
    trajectory: list[dict] = field(default_factory=list)


@dataclass
class PlayerStateEvent:
    tick: int
    round_number: int
    player_id: int  # SteamID64
    event_type: str  # 'hurt' | 'equip' | 'spawn'
    hp: int | None = None
    armor: int | None = None
    weapon: str | None = None


@dataclass
class ParsedDemo:
    match_info: MatchInfo
    rounds: list[RoundInfo] = field(default_factory=list)
    players: list[PlayerInfo] = field(default_factory=list)
    positions: list[PlayerPosition] = field(default_factory=list)
    events: list[GameEvent] = field(default_factory=list)
    grenades: list[GrenadeEvent] = field(default_factory=list)
    player_state_events: list[PlayerStateEvent] = field(default_factory=list)
