"""
Game event, economy, and player-state-event extraction.

Covers:
  _extract_events             – kills and bomb events
  _extract_economy            – equipment values at freeze_end
  _extract_player_state_events – HP/armor changes, weapon equips, spawns
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict

from ._types import GameEvent, PlayerStateEvent, RoundInfo
from ._utils import _build_round_lookup, _rows, _to_int

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Inventory prop → weapon-token mapping
#
# The `inventory` entity prop (read via parse_ticks) reports each player's
# current weapons as human-readable display names ("AK-47", "Smoke Grenade").
# We map those to the bare weapon tokens the frontend already understands
# (it prepends "weapon_" during classification), so inventory-sourced equips
# are indistinguishable from item_purchase/item_equip events downstream.
#
# Armor (kevlar/helmet) is deliberately NOT mapped here: the armor bar is
# driven by the dedicated armor prop, and emitting armor "equips" would
# interfere with it.  Knives, C4 and Zeus are intentionally unmapped too —
# they carry no loadout meaning for the pistol/primary/nade panel.
#
# Keys are normalised display names (lower-cased, non-alphanumerics stripped).
# ---------------------------------------------------------------------------
_INVENTORY_NAME_TO_TOKEN: dict[str, str] = {
    # Pistols
    "glock18": "glock",
    "p2000": "hkp2000",
    "usps": "usp_silencer",
    "dualberettas": "elite",
    "p250": "p250",
    "tec9": "tec9",
    "fiveseven": "fiveseven",
    "cz75auto": "cz75a",
    "deserteagle": "deagle",
    "r8revolver": "revolver",
    # SMGs
    "mac10": "mac10",
    "mp9": "mp9",
    "mp7": "mp7",
    "mp5sd": "mp5sd",
    "ump45": "ump45",
    "p90": "p90",
    "ppbizon": "bizon",
    # Rifles
    "galilar": "galilar",
    "famas": "famas",
    "ak47": "ak47",
    "m4a4": "m4a1",
    "m4a1s": "m4a1_silencer",
    "sg553": "sg556",
    "aug": "aug",
    # Snipers
    "ssg08": "ssg08",
    "awp": "awp",
    "g3sg1": "g3sg1",
    "scar20": "scar20",
    # Heavy
    "nova": "nova",
    "xm1014": "xm1014",
    "sawedoff": "sawedoff",
    "mag7": "mag7",
    "m249": "m249",
    "negev": "negev",
    # Grenades
    "smokegrenade": "smokegrenade",
    "flashbang": "flashbang",
    "highexplosivegrenade": "hegrenade",
    "incendiarygrenade": "incgrenade",
    "molotov": "molotov",
    "decoygrenade": "decoy",
}


def _inventory_item_to_token(name: object) -> str | None:
    """Map one inventory entry to a weapon token, or None to skip it."""
    raw = str(name or "").strip()
    if not raw:
        return None
    low = raw.lower()
    # Some builds report classnames directly ("weapon_ak47"); pass those
    # through untouched — the frontend normaliser already handles them.
    if low.startswith(("weapon_", "item_")):
        return low
    norm = re.sub(r"[^a-z0-9]", "", low)
    return _INVENTORY_NAME_TO_TOKEN.get(norm)


# ---------------------------------------------------------------------------
# Kill and bomb events
# ---------------------------------------------------------------------------


def _extract_events(
    parser,
    rounds: list[RoundInfo],
    map_name: str | None = None,
) -> list[GameEvent]:
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

    # Resolve bombsite centres for position-based site labelling. demoparser2's
    # `site` column reports the bombsite trigger's entity index (varies per
    # map), not a 0/1 site index, so the planter's X/Y is the reliable signal.
    from maps.calibration import get_calibration  # local import to avoid cycle

    calibration = get_calibration(map_name) if map_name else None
    site_a = calibration.bombsite_a if calibration else None
    site_b = calibration.bombsite_b if calibration else None

    def _classify_site(ux: object, uy: object) -> str | None:
        if site_a is None or site_b is None:
            return None
        try:
            px = float(ux)  # type: ignore[arg-type]
            py = float(uy)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        da = (px - site_a[0]) ** 2 + (py - site_a[1]) ** 2
        db = (px - site_b[0]) ** 2 + (py - site_b[1]) ** 2
        return "A" if da <= db else "B"

    # Bomb events
    for event_name in ("bomb_planted", "bomb_defused", "bomb_exploded"):
        try:
            kwargs: dict = {"other": ["tick"]}
            if event_name == "bomb_planted":
                kwargs["player"] = ["X", "Y"]
            df = parser.parse_event(event_name, **kwargs)
            for row in _rows(df):
                tick = _to_int(row.get("tick", 0))
                weapon: str | None = None
                if event_name == "bomb_planted":
                    weapon = _classify_site(row.get("user_X"), row.get("user_Y"))
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


def _extract_player_state_events(
    parser,
    rounds: list[RoundInfo],
    tick_rate: float = 64.0,
) -> list[PlayerStateEvent]:
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

    # -- inventory prop sampling (robust weapon source) ----------------------
    # item_equip / item_pickup / item_purchase events are absent in some demos
    # (POV recordings, certain sources / parser builds), which leaves loadouts
    # blank.  The `inventory` entity prop is read the same way as positions and
    # HP (parse_ticks), so it is populated whenever those are — making it a
    # reliable fallback.  We sample each player's inventory just after freeze
    # end (post-buy loadout) and periodically through the round (mid-round
    # pickups), emitting equip events indistinguishable from the event-based
    # ones.  Duplicates are harmless: the frontend accumulates weapons into a
    # Set.  Demos that already have item_* events simply gain confirming data.
    try:
        step = max(64, int(round(tick_rate * 5)))  # ~5 s between samples
        inv_tick_to_round: dict[int, int] = {}
        for r in rounds:
            t = max(r.start_tick, r.freeze_end_tick)
            while t <= r.end_tick:
                inv_tick_to_round.setdefault(t, r.round_number)
                t += step

        inv_ticks = sorted(inv_tick_to_round)
        if inv_ticks:
            inv_df = parser.parse_ticks(["steamid", "inventory"], ticks=inv_ticks)
            # Emit each weapon once per (round, player) at the earliest tick it
            # appears — process rows in tick order and dedupe.  Re-emitting a
            # held weapon every sample would bloat the table with no benefit
            # (the frontend accumulates weapons additively).
            seen_equip: set[tuple[int, int, str]] = set()
            equip_count = 0
            for row in sorted(_rows(inv_df), key=lambda r: _to_int(r.get("tick", 0))):
                tick = _to_int(row.get("tick", 0))
                rn = inv_tick_to_round.get(tick) or _rn(tick)
                if not rn:
                    continue
                player_id = _event_player_id(row)
                if player_id == 0:
                    continue
                inventory = row.get("inventory")
                # Accept any non-string iterable (list / tuple / ndarray);
                # skip None, NaN scalars and bare strings.
                if inventory is None or isinstance(inventory, str | bytes):
                    continue
                try:
                    items = list(inventory)
                except TypeError:
                    continue
                for item in items:
                    token = _inventory_item_to_token(item)
                    if token is None:
                        continue
                    key = (rn, player_id, token)
                    if key in seen_equip:
                        continue
                    seen_equip.add(key)
                    state_events.append(
                        PlayerStateEvent(
                            tick=tick,
                            round_number=rn,
                            player_id=player_id,
                            event_type="equip",
                            weapon=token,
                        )
                    )
                    equip_count += 1
            logger.info("Inventory sampling produced %d equip events", equip_count)
    except Exception as exc:
        logger.warning("Could not sample inventory props: %s", exc)

    logger.info("Extracted %d player state events", len(state_events))
    return sorted(state_events, key=lambda e: e.tick)
