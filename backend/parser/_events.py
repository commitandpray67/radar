"""
Game event, economy, and player-state-event extraction.

Covers:
  _extract_events             – kills and bomb events
  _extract_economy            – equipment values at freeze_end
  _extract_player_state_events – HP/armor changes, weapon equips, spawns
"""

from __future__ import annotations

import logging
from collections import defaultdict

from ._types import GameEvent, PlayerStateEvent, RoundInfo
from ._utils import _build_round_lookup, _rows, _to_int

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Kill and bomb events
# ---------------------------------------------------------------------------


def _extract_events(parser, rounds: list[RoundInfo]) -> list[GameEvent]:
    """Extract kill and bomb events."""
    _rn = _build_round_lookup(rounds)
    events: list[GameEvent] = []

    # Kills
    try:
        kills_df = parser.parse_event(
            "player_death",
            other=["tick", "attacker_steamid", "user_steamid", "weapon", "headshot"],
        )
        for row in _rows(kills_df):
            tick = _to_int(row.get("tick", 0))
            events.append(
                GameEvent(
                    tick=tick,
                    round_number=_rn(tick),
                    event_type="player_death",
                    attacker_id=_to_int(row.get("attacker_steamid", 0)) or None,
                    victim_id=_to_int(row.get("user_steamid", 0)) or None,
                    weapon=str(row.get("weapon", "") or ""),
                    headshot=bool(row.get("headshot", False)),
                )
            )
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
                    site_raw = row.get("site", row.get("bombsite"))
                    if site_raw is not None:
                        weapon = "A" if int(site_raw) == 0 else "B"
                events.append(
                    GameEvent(
                        tick=tick,
                        round_number=_rn(tick),
                        event_type=event_name,
                        weapon=weapon,
                    )
                )
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    return sorted(events, key=lambda e: e.tick)


# ---------------------------------------------------------------------------
# Economy (equipment values at freeze_end)
# ---------------------------------------------------------------------------


def _extract_economy(parser, rounds: list[RoundInfo]) -> list[RoundInfo]:
    """Fill ct_equip_value / t_equip_value on each RoundInfo."""
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
        r.t_equip_value = snap.get(2, 0)  # team_num 2 = T

    logger.info("Economy extracted for %d rounds", len(rounds))
    return rounds


# ---------------------------------------------------------------------------
# Player state events
# ---------------------------------------------------------------------------


def _extract_player_state_events(parser, rounds: list[RoundInfo]) -> list[PlayerStateEvent]:
    """Extract HP/armor changes and weapon equip events."""
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

    def _optional_nonneg_int(value: object) -> int | None:
        if value is None:
            return None
        if isinstance(value, str) and value.strip() == "":
            return None
        try:
            parsed = int(value)  # type: ignore[call-overload]
        except (TypeError, ValueError):
            return None
        return max(0, parsed)

    def _row_hp(row: dict, default: object = None) -> int | None:
        return _optional_nonneg_int(
            row.get("hp", row.get("health", row.get("user_health", default)))
        )

    def _row_armor(row: dict) -> int | None:
        return _optional_nonneg_int(row.get("armor", row.get("armor_value", row.get("user_armor"))))

    state_events: list[PlayerStateEvent] = []

    # -- player_hurt ---------------------------------------------------------
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
            state_events.append(
                PlayerStateEvent(
                    tick=tick,
                    round_number=rn,
                    player_id=player_id,
                    event_type="hurt",
                    hp=_row_hp(row),
                    armor=_row_armor(row),
                    weapon=str(row.get("weapon", "") or ""),
                )
            )
    except Exception as exc:
        logger.warning("Could not parse player_hurt: %s", exc)

    # -- item_equip ----------------------------------------------------------
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
            state_events.append(
                PlayerStateEvent(
                    tick=tick,
                    round_number=rn,
                    player_id=player_id,
                    event_type="equip",
                    weapon=item,
                )
            )
    except Exception as exc:
        logger.warning("Could not parse item_equip: %s", exc)

    # -- item_pickup ---------------------------------------------------------
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
            state_events.append(
                PlayerStateEvent(
                    tick=tick,
                    round_number=rn,
                    player_id=player_id,
                    event_type="equip",
                    weapon=item,
                )
            )
    except Exception as exc:
        logger.debug("Could not parse item_pickup: %s", exc)

    # -- item_purchase -------------------------------------------------------
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
            state_events.append(
                PlayerStateEvent(
                    tick=tick,
                    round_number=rn,
                    player_id=player_id,
                    event_type="equip",
                    weapon=weapon,
                )
            )
    except Exception as exc:
        logger.debug("Could not parse item_purchase: %s", exc)

    # -- player_spawn --------------------------------------------------------
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
            state_events.append(
                PlayerStateEvent(
                    tick=tick,
                    round_number=rn,
                    player_id=player_id,
                    event_type="spawn",
                    hp=_row_hp(row, 100),
                    armor=_row_armor(row),
                )
            )
    except Exception as exc:
        logger.debug("Could not parse player_spawn: %s", exc)

    # -- freeze_end tick-based fallback (captures true round-start HP/armor) -
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
                state_events.append(
                    PlayerStateEvent(
                        tick=tick,
                        round_number=rn,
                        player_id=player_id,
                        event_type="spawn",
                        hp=hp,
                        armor=armor,
                    )
                )
    except Exception as exc:
        logger.debug("Could not parse freeze_end tick state: %s", exc)

    logger.info("Extracted %d player state events", len(state_events))
    return sorted(state_events, key=lambda e: e.tick)
