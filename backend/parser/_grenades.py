"""Grenade extraction: matches weapon_fire throws to detonation events."""

from __future__ import annotations

import logging
import math
from collections import defaultdict

from ._types import GrenadeEvent, RoundInfo
from ._utils import _build_round_lookup, _coord, _rows, _to_int

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lookup tables
# ---------------------------------------------------------------------------

# weapon_fire weapon name → normalised grenade type
_GRENADE_WEAPONS: dict[str, str] = {
    "hegrenade": "he",
    "weapon_hegrenade": "he",
    "flashbang": "flash",
    "weapon_flashbang": "flash",
    "smokegrenade": "smoke",
    "weapon_smokegrenade": "smoke",
    "molotov": "molotov",
    "weapon_molotov": "molotov",
    "incgrenade": "incendiary",
    "weapon_incgrenade": "incendiary",
    "decoy": "decoy",
    "weapon_decoy": "decoy",
}

# Detonation event name → normalised grenade type
_DETONATE_EVENTS: dict[str, str] = {
    "hegrenade_detonate": "he",
    "flashbang_detonate": "flash",
    "smokegrenade_detonate": "smoke",
    "molotov_detonate": "molotov",
    "inferno_startburn": "molotov",  # covers both molotov & incendiary
}

# parse_grenades() entity class names → normalised type
_TRAJ_TYPE_MAP: dict[str, str] = {
    "hegrenade": "he",
    "chegrenadeprojectile": "he",
    "flashbang": "flash",
    "cflashbangprojectile": "flash",
    "smokegrenade": "smoke",
    "csmokegrenadeprojectile": "smoke",
    "molotov": "molotov",
    "cmolotovprojectile": "molotov",
    "molotovgrenade": "molotov",
    "incendiarygrenade": "incendiary",
    "cincendiaryprojectile": "incendiary",
    "incendiary": "incendiary",
    "decoygrenade": "decoy",
    "cdecoyprojectile": "decoy",
    "decoy": "decoy",
    "cdecoyprojector": "decoy",
}

# Substring fallback for entity class names (most specific first)
_TRAJ_SUBSTR_FALLBACK: list[tuple[str, str]] = [
    ("hegrenade", "he"),
    ("flashbang", "flash"),
    ("smokegrenade", "smoke"),
    ("smoke", "smoke"),
    ("molotov", "molotov"),
    ("incendiary", "incendiary"),
    ("decoy", "decoy"),
]

# Approximate effect duration in ticks at 64 tick (scaled if tick_rate differs)
_EFFECT_TICKS: dict[str, int] = {
    "he": 64,  # ~1 s
    "flash": 48,
    "smoke": 1152,  # ~18 s
    "molotov": 448,  # ~7 s
    "incendiary": 448,
    "decoy": 256,  # ~4 s
}


def _map_grenade_type(raw: str) -> str | None:
    """Map a raw parse_grenades() grenade_type string to our normalised type."""
    key = raw.lower().replace(" ", "").replace("_", "")
    result = _TRAJ_TYPE_MAP.get(key)
    if result is not None:
        return result
    for substr, gtype in _TRAJ_SUBSTR_FALLBACK:
        if substr in key:
            return gtype
    return None


# ---------------------------------------------------------------------------
# Trajectory tracker
# ---------------------------------------------------------------------------


def _build_tracks(bucket_sorted: list[dict]) -> list[list[dict]]:
    """Tick-batched nearest-neighbour multi-object tracker.

    parse_grenades() emits rows per tick for EVERY live projectile of a type —
    including grenades resting on the ground (a landed smoke keeps emitting at
    its rest position for its whole ~18 s lifetime) and duplicate rows for the
    same projectile within one tick.

    The old row-at-a-time tracker caused the long-standing "webbing" artifact:
    a second grenade flying within the match radius of a resting one had its
    rows appended to the SAME track, which then alternated rest↔flight point —
    rendered as a fan of straight lines between the rest spot and the arc.

    Fixed by processing one tick at a time with three constraints:
      1. near-duplicate rows within a tick collapse to one observation,
      2. observations are matched to tracks greedily by distance with each
         observation AND each track used at most once per tick (two same-tick
         rows are two different projectiles — they can never share a track),
      3. a row with a known thrower never extends another thrower's track.
    """
    MATCH_DIST_SQ = 500**2  # max squared distance to continue a track
    TRACK_GAP = 16  # retire a track idle for this many ticks
    DUP_DIST_SQ = 4.0**2  # same-tick rows closer than this are one projectile

    active: list[dict] = []
    finished: list[list[dict]] = []

    i, n = 0, len(bucket_sorted)
    while i < n:
        tick = bucket_sorted[i]["tick"]
        tick_rows: list[dict] = []
        while i < n and bucket_sorted[i]["tick"] == tick:
            tick_rows.append(bucket_sorted[i])
            i += 1

        # Retire stale tracks
        live: list[dict] = []
        for t in active:
            if tick - t["last_tick"] <= TRACK_GAP:
                live.append(t)
            else:
                finished.append(t["pts"])
        active = live

        # 1. Collapse near-duplicate observations of the same projectile.
        obs: list[dict] = []
        for row in tick_rows:
            if not any(
                (row["x"] - o["x"]) ** 2 + (row["y"] - o["y"]) ** 2 <= DUP_DIST_SQ
                for o in obs
            ):
                obs.append(row)

        # 2. Greedy min-distance assignment, each obs/track used once per tick.
        pairs: list[tuple[float, int, int]] = []
        for oi, row in enumerate(obs):
            r_thrower = row.get("thrower_id", 0)
            for ti, t in enumerate(active):
                # 3. A known thrower never extends another thrower's track.
                if r_thrower and t["thrower_id"] and r_thrower != t["thrower_id"]:
                    continue
                dsq = (row["x"] - t["last_x"]) ** 2 + (row["y"] - t["last_y"]) ** 2
                if dsq < MATCH_DIST_SQ:
                    pairs.append((dsq, oi, ti))
        pairs.sort(key=lambda p: p[0])

        used_obs: set[int] = set()
        used_trk: set[int] = set()
        for _dsq, oi, ti in pairs:
            if oi in used_obs or ti in used_trk:
                continue
            used_obs.add(oi)
            used_trk.add(ti)
            t = active[ti]
            row = obs[oi]
            t["pts"].append(row)
            t["last_x"], t["last_y"], t["last_tick"] = row["x"], row["y"], tick
            if not t["thrower_id"]:
                t["thrower_id"] = row.get("thrower_id", 0)

        # Unmatched observations start new tracks.
        for oi, row in enumerate(obs):
            if oi not in used_obs:
                active.append(
                    {
                        "pts": [row],
                        "last_x": row["x"],
                        "last_y": row["y"],
                        "last_tick": tick,
                        "thrower_id": row.get("thrower_id", 0),
                    }
                )

    for t in active:
        finished.append(t["pts"])
    return [pts for pts in finished if len(pts) >= 2]


# ---------------------------------------------------------------------------
# Main extractor
# ---------------------------------------------------------------------------


def _extract_grenades(
    parser, rounds: list[RoundInfo], tick_rate: float = 64.0
) -> list[GrenadeEvent]:
    """Match weapon_fire (throw) events to detonation events, attach trajectories."""
    _rn = _build_round_lookup(rounds)

    # ---- Throws (weapon_fire filtered to grenade weapons) ------------------
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
            throws.append(
                {
                    "tick": tick,
                    "round_number": rn,
                    "thrower_id": _to_int(row.get("user_steamid", 0)),
                    "grenade_type": nade_type,
                }
            )
    except Exception as exc:
        logger.warning("Could not parse weapon_fire for grenades: %s", exc)

    # ---- Detonations -------------------------------------------------------
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
                x = _coord(row, "x", "X")
                y = _coord(row, "y", "Y")
                if x is None or y is None:
                    continue
                detonations.append(
                    {
                        "tick": tick,
                        "round_number": rn,
                        "grenade_type": nade_type,
                        "x": x,
                        "y": y,
                        "z": _coord(row, "z", "Z") or 0.0,
                        "thrower_id": _to_int(row.get("user_steamid", 0)),
                    }
                )
        except Exception as exc:
            logger.debug("Could not parse %s: %s", event_name, exc)

    # ---- Expire events (smoke / fire end) stored per round for lookup ------
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

    # ---- Per-tick trajectory from parse_grenades() -------------------------
    raw_traj: list[dict] = []
    try:
        traj_df = parser.parse_grenades()
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

            def _fv(key_upper, key_lower, _row=row):
                v = _row.get(key_upper)
                if v is None:
                    v = _row.get(key_lower)
                if v is None:
                    return None
                try:
                    f = float(v)
                except (TypeError, ValueError):
                    return None
                return None if math.isnan(f) or math.isinf(f) else f

            x = _fv("X", "x")
            y = _fv("Y", "y")
            z_val = _fv("Z", "z")
            if x is None or y is None:
                continue
            z = z_val if z_val is not None else 0.0
            if z < -4096:
                continue  # grenade entity parked below map while in inventory

            raw_sid = row.get("thrower_steamid")
            try:
                thrower_id = (
                    0
                    if raw_sid is None or (isinstance(raw_sid, float) and math.isnan(raw_sid))
                    else int(float(raw_sid))
                )
            except Exception:
                thrower_id = 0

            raw_traj.append(
                {
                    "gtype": gtype,
                    "tick": tick,
                    "rn": rn,
                    "x": x,
                    "y": y,
                    "z": z,
                    "thrower_id": thrower_id,
                }
            )

        logger.info("parse_grenades() raw types: %s", sorted(_seen_raw_types))
        logger.info("parse_grenades() usable rows: %d", len(raw_traj))
    except Exception as exc:
        logger.warning("Could not extract trajectories via parse_grenades(): %s", exc)

    # ---- Match throws to detonations ---------------------------------------
    # Flight/effect tick budgets below are calibrated at 64 tick; scale them so
    # 128-tick demos get correct durations (e.g. a smoke is ~18 s on any rate).
    _tick_scale = tick_rate / 64.0 if tick_rate and tick_rate > 0 else 1.0
    MAX_FLIGHT_TICKS = int(round(448 * _tick_scale))
    used_det: set[int] = set()
    grenades: list[GrenadeEvent] = []

    dets_by_round: dict[int, list[tuple[int, dict]]] = {}
    for _i, _det in enumerate(detonations):
        dets_by_round.setdefault(_det["round_number"], []).append((_i, _det))

    for throw in sorted(throws, key=lambda t: t["tick"]):
        best_idx: int | None = None
        best_diff = MAX_FLIGHT_TICKS + 1

        for i, det in dets_by_round.get(throw["round_number"], []):
            if i in used_det:
                continue
            nt, dt = throw["grenade_type"], det["grenade_type"]
            if nt != dt and not (nt in ("molotov", "incendiary") and dt == "molotov"):
                continue
            diff = det["tick"] - throw["tick"]
            if diff < 0 or diff > MAX_FLIGHT_TICKS:
                continue
            # thrower_id 0 = unknown (world/bot); only enforce a match when both
            # the throw and the detonation have a known, non-zero thrower.
            det_thrower = det["thrower_id"]
            throw_thrower = throw["thrower_id"]
            if det_thrower and throw_thrower and det_thrower != throw_thrower:
                continue
            if diff < best_diff:
                best_diff = diff
                best_idx = i

        if best_idx is None:
            grenades.append(
                GrenadeEvent(
                    round_number=throw["round_number"],
                    thrower_id=throw["thrower_id"],
                    grenade_type=throw["grenade_type"],
                    throw_tick=throw["tick"],
                )
            )
            continue

        used_det.add(best_idx)
        det = detonations[best_idx]
        nade_type = throw["grenade_type"]
        # Throws with an unknown grenade type are skipped at creation time, so
        # this is always a concrete string here (narrows str | None for mypy).
        assert nade_type is not None

        # Nearest-neighbour expire-tick lookup (200-unit radius)
        expire_tick: int | None = None
        _EXPIRE_MATCH_DIST_SQ = 200**2
        for candidate in expire_list.get(det["round_number"], []):
            dx = candidate["x"] - det["x"]
            dy = candidate["y"] - det["y"]
            if dx * dx + dy * dy <= _EXPIRE_MATCH_DIST_SQ:
                if expire_tick is None or candidate["tick"] < expire_tick:
                    expire_tick = candidate["tick"]
        if expire_tick is None:
            base_ticks = _EFFECT_TICKS.get(nade_type, 64)
            expire_tick = det["tick"] + int(round(base_ticks * _tick_scale))

        grenades.append(
            GrenadeEvent(
                round_number=throw["round_number"],
                thrower_id=throw["thrower_id"],
                grenade_type=nade_type,
                throw_tick=throw["tick"],
                detonate_tick=det["tick"],
                x=det["x"],
                y=det["y"],
                z=det["z"],
                expire_tick=expire_tick,
                trajectory=[],  # filled in below
            )
        )

    # ---- Build trajectory tracks (used for attachment and fallback) --------
    MAX_TRAJ_WP = 48

    def _sample_track(track: list[dict]) -> list[dict]:
        """Down-sample a raw track to at most ~MAX_TRAJ_WP {tick,x,y,z} points."""
        step = max(1, len(track) // MAX_TRAJ_WP)
        sampled = track[::step]
        if sampled[-1] is not track[-1]:
            sampled.append(track[-1])
        return [{"tick": r["tick"], "x": r["x"], "y": r["y"], "z": r["z"]} for r in sampled]

    track_index: dict[tuple[str, int], list[list[dict]]] = {}
    if raw_traj:
        raw_by_key: dict[tuple[str, int], list[dict]] = defaultdict(list)
        for r in raw_traj:
            raw_by_key[(r["gtype"], r["rn"])].append(r)
        for key, bucket in raw_by_key.items():
            bucket.sort(key=lambda r: r["tick"])
            track_index[key] = _build_tracks(bucket)

    # ---- Fallback: synthesize grenades from trajectories when no throws -----
    # weapon_fire (and item_* / detonation events) are absent in some demos —
    # the same ones with blank loadouts.  parse_grenades() is an entity/prop
    # source (like positions), so it still carries the projectile flight paths
    # even when the events don't exist.  Rebuild grenade events directly from
    # those tracks: each track is one thrown nade, its last point ≈ where it
    # detonated / came to rest.  Triggers only when the throw-based path yielded
    # nothing renderable, so demos that already work are left untouched.
    if track_index and not any(g.detonate_tick is not None for g in grenades):
        grenades = []  # drop any throw-only stubs that carry no position
        for (gtype, rn), tracks in track_index.items():
            for track in tracks:
                if len(track) < 2:
                    continue
                last = track[-1]
                thrower_id = next((p["thrower_id"] for p in track if p["thrower_id"]), 0)
                base_ticks = _EFFECT_TICKS.get(gtype, 64)
                grenades.append(
                    GrenadeEvent(
                        round_number=rn,
                        thrower_id=thrower_id,
                        grenade_type=gtype,
                        throw_tick=track[0]["tick"],
                        detonate_tick=last["tick"],
                        x=last["x"],
                        y=last["y"],
                        z=last["z"],
                        expire_tick=last["tick"] + int(round(base_ticks * _tick_scale)),
                        trajectory=_sample_track(track),
                    )
                )
        grenades.sort(key=lambda g: g.throw_tick)
        logger.info(
            "No weapon_fire throws — synthesized %d grenade events from trajectories",
            len(grenades),
        )

    # ---- Attach trajectory waypoints to throw-based grenades ---------------
    if track_index:
        for g in grenades:
            # Skip nades that already carry a path (synthesized above) or that
            # never detonated (nothing to match a flight path to).
            if g.trajectory or g.detonate_tick is None:
                continue
            all_tracks = track_index.get((g.grenade_type, g.round_number), [])
            if not all_tracks:
                continue

            candidates: list[list[dict]] = []
            for track in all_tracks:
                window = [
                    r
                    for r in track
                    if g.throw_tick <= r["tick"] <= g.detonate_tick
                    and not (r["thrower_id"] and g.thrower_id and r["thrower_id"] != g.thrower_id)
                ]
                if len(window) >= 2:
                    candidates.append(window)

            if not candidates:
                continue

            best = min(
                candidates,
                key=lambda pts: (pts[-1]["x"] - g.x) ** 2 + (pts[-1]["y"] - g.y) ** 2,
            )
            g.trajectory = _sample_track(best)

        attached = sum(1 for g in grenades if g.trajectory)
        logger.info("Attached trajectories to %d/%d grenades", attached, len(grenades))

    logger.info("Extracted %d grenade events", len(grenades))
    return grenades
