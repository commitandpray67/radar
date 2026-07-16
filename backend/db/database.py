"""
SQLite-backed cache for parsed demo data.

Schema
------
  demos         – one row per parsed demo file (keyed by file hash)
  rounds        – round metadata per demo
  players       – player roster per demo
  player_positions – sampled tick-level positions
  events        – game events (kills, bomb events)

We use aiosqlite for async I/O so FastAPI background tasks don't block.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC
from pathlib import Path

import aiosqlite

logger = logging.getLogger(__name__)

# Default path; overridable via env var DB_PATH
DEFAULT_DB_PATH = Path(__file__).parent.parent / "data" / "demos.db"


async def get_db_path() -> Path:
    import os

    p = Path(os.environ.get("DB_PATH", str(DEFAULT_DB_PATH)))
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


@asynccontextmanager
async def get_connection() -> AsyncIterator[aiosqlite.Connection]:
    db_path = await get_db_path()
    async with aiosqlite.connect(str(db_path), timeout=30) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA journal_mode=WAL")
        await conn.execute("PRAGMA foreign_keys=ON")
        await conn.execute("PRAGMA synchronous=NORMAL")  # safe with WAL, faster
        await conn.execute("PRAGMA busy_timeout=10000")  # 10 s retry on lock
        await conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
        yield conn


async def init_db() -> None:
    """Create tables if they don't exist."""
    async with get_connection() as conn:
        await conn.executescript("""
            CREATE TABLE IF NOT EXISTS demos (
                id          TEXT PRIMARY KEY,   -- SHA-256 of file
                filename    TEXT NOT NULL,
                map_name    TEXT NOT NULL,
                tick_rate   REAL NOT NULL,
                total_ticks INTEGER NOT NULL,
                parsed_at   TEXT NOT NULL,      -- ISO timestamp
                meta_json   TEXT DEFAULT '{}',  -- spare JSON blob
                file_size   INTEGER DEFAULT 0   -- bytes
            );

            CREATE TABLE IF NOT EXISTS rounds (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id             TEXT NOT NULL REFERENCES demos(id),
                round_number        INTEGER NOT NULL,
                start_tick          INTEGER NOT NULL,
                end_tick            INTEGER NOT NULL,
                freeze_end_tick     INTEGER NOT NULL,
                winner_team         TEXT,
                win_reason          TEXT,
                ct_score            INTEGER,
                t_score             INTEGER,
                bomb_planted_tick   INTEGER,
                bomb_defused_tick   INTEGER,
                bomb_exploded_tick  INTEGER,
                is_knife_round      INTEGER DEFAULT 0,
                ct_equip_value      INTEGER DEFAULT 0,
                t_equip_value       INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS players (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id         TEXT NOT NULL REFERENCES demos(id),
                player_id       INTEGER NOT NULL,  -- SteamID64
                name            TEXT NOT NULL,
                initial_team    TEXT
            );

            CREATE TABLE IF NOT EXISTS player_positions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id         TEXT NOT NULL REFERENCES demos(id),
                tick            INTEGER NOT NULL,
                round_number    INTEGER NOT NULL,
                player_id       INTEGER NOT NULL,
                x               REAL NOT NULL,
                y               REAL NOT NULL,
                z               REAL NOT NULL,
                team_num        INTEGER,
                is_alive        INTEGER,         -- 0/1
                yaw             REAL DEFAULT 0   -- view angle degrees
            );

            CREATE TABLE IF NOT EXISTS events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id         TEXT NOT NULL REFERENCES demos(id),
                tick            INTEGER NOT NULL,
                round_number    INTEGER NOT NULL,
                event_type      TEXT NOT NULL,
                attacker_id     INTEGER,
                victim_id       INTEGER,
                weapon          TEXT,
                headshot        INTEGER          -- 0/1
            );

            CREATE TABLE IF NOT EXISTS grenades (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id         TEXT NOT NULL REFERENCES demos(id),
                round_number    INTEGER NOT NULL,
                thrower_id      INTEGER NOT NULL,
                grenade_type    TEXT NOT NULL,
                throw_tick      INTEGER NOT NULL,
                detonate_tick   INTEGER,
                x               REAL,
                y               REAL,
                z               REAL,
                expire_tick     INTEGER,
                trajectory      TEXT
            );

            CREATE TABLE IF NOT EXISTS player_state_events (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id         TEXT NOT NULL REFERENCES demos(id),
                tick            INTEGER NOT NULL,
                round_number    INTEGER NOT NULL,
                player_id       INTEGER NOT NULL,
                event_type      TEXT NOT NULL,
                hp              INTEGER,
                armor           INTEGER,
                weapon          TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_pos_demo_round
                ON player_positions(demo_id, round_number);
            CREATE INDEX IF NOT EXISTS idx_pos_player
                ON player_positions(demo_id, player_id);
            CREATE INDEX IF NOT EXISTS idx_pos_tick
                ON player_positions(demo_id, round_number, tick);
            CREATE INDEX IF NOT EXISTS idx_events_demo
                ON events(demo_id, round_number);
            CREATE INDEX IF NOT EXISTS idx_grenades_demo
                ON grenades(demo_id, round_number);
            CREATE INDEX IF NOT EXISTS idx_pstate_demo
                ON player_state_events(demo_id, round_number);

            CREATE TABLE IF NOT EXISTS team_sessions (
                id                   TEXT PRIMARY KEY,    -- uuid
                name                 TEXT NOT NULL,
                map_name             TEXT NOT NULL,
                demo_ids_json        TEXT NOT NULL,       -- list[str]
                team_sides_json      TEXT NOT NULL,       -- {demo_id: "CT"|"T"}
                core_roster_json     TEXT NOT NULL,       -- list[str] (steamid64 as str)
                extended_roster_json TEXT NOT NULL,       -- list[str]
                created_at           TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS teams (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS team_demo_refs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                demo_id    TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
                added_at   TEXT NOT NULL,
                UNIQUE(team_id, demo_id)
            );
        """)
        # Migrations: add columns / tables that older DBs may be missing
        for migration in [
            "ALTER TABLE rounds ADD COLUMN is_knife_round INTEGER DEFAULT 0",
            "ALTER TABLE grenades ADD COLUMN trajectory TEXT",
            "ALTER TABLE rounds ADD COLUMN ct_equip_value INTEGER DEFAULT 0",
            "ALTER TABLE rounds ADD COLUMN t_equip_value INTEGER DEFAULT 0",
            "ALTER TABLE player_positions ADD COLUMN yaw REAL DEFAULT 0",
            "ALTER TABLE demos ADD COLUMN file_size INTEGER DEFAULT 0",
            # Index migrations (CREATE INDEX IF NOT EXISTS is idempotent)
            "CREATE INDEX IF NOT EXISTS idx_pos_tick ON player_positions(demo_id, round_number, tick)",
        ]:
            try:
                await conn.execute(migration)
                await conn.commit()
            except Exception:
                pass  # already exists
        await conn.commit()
    logger.info("Database initialised at %s", await get_db_path())


def file_hash(path: Path, chunk: int = 4 << 20) -> str:
    """Fast content fingerprint: SHA-256 of head + tail + size.

    Hashing only the head risks collisions between demos that share an
    identical prefix (same server/warmup header — common on FACEIT), so the
    last chunk and the file size are folded in while staying O(8 MB) on
    multi-hundred-MB files.  Blocking IO — call via an executor from async
    code.
    """
    h = hashlib.sha256()
    size = path.stat().st_size
    with open(path, "rb") as f:
        h.update(f.read(chunk))
        if size > 2 * chunk:
            f.seek(-chunk, os.SEEK_END)
            h.update(f.read(chunk))
    h.update(str(size).encode())
    return h.hexdigest()


async def demo_exists(demo_id: str) -> bool:
    async with get_connection() as conn:
        cursor = await conn.execute("SELECT 1 FROM demos WHERE id = ?", (demo_id,))
        row = await cursor.fetchone()
        return row is not None


async def store_demo(parsed, demo_id: str, filename: str, file_size: int = 0) -> None:
    """Persist a ParsedDemo into the database."""
    import json as _json
    from datetime import datetime

    from parser.demo_parser import PARSER_VERSION

    async with get_connection() as conn:
        # demos — store parser_version in meta_json so stale caches are detected
        await conn.execute(
            """INSERT OR REPLACE INTO demos
               (id, filename, map_name, tick_rate, total_ticks, parsed_at, meta_json, file_size)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                demo_id,
                filename,
                parsed.match_info.map_name,
                parsed.match_info.tick_rate,
                parsed.match_info.total_ticks,
                datetime.now(UTC).isoformat(),
                _json.dumps({"parser_version": PARSER_VERSION}),
                file_size,
            ),
        )

        # rounds
        await conn.execute("DELETE FROM rounds WHERE demo_id = ?", (demo_id,))
        await conn.executemany(
            """INSERT INTO rounds
               (demo_id, round_number, start_tick, end_tick, freeze_end_tick,
                winner_team, win_reason, ct_score, t_score,
                bomb_planted_tick, bomb_defused_tick, bomb_exploded_tick,
                is_knife_round, ct_equip_value, t_equip_value)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (
                    demo_id,
                    r.round_number,
                    r.start_tick,
                    r.end_tick,
                    r.freeze_end_tick,
                    r.winner_team,
                    r.win_reason,
                    r.ct_score,
                    r.t_score,
                    r.bomb_planted_tick,
                    r.bomb_defused_tick,
                    r.bomb_exploded_tick,
                    int(r.is_knife_round),
                    r.ct_equip_value,
                    r.t_equip_value,
                )
                for r in parsed.rounds
            ],
        )

        # players
        await conn.execute("DELETE FROM players WHERE demo_id = ?", (demo_id,))
        await conn.executemany(
            """INSERT INTO players (demo_id, player_id, name, initial_team)
               VALUES (?,?,?,?)""",
            [(demo_id, p.player_id, p.name, p.initial_team) for p in parsed.players],
        )

        # positions (batch insert for performance)
        await conn.execute("DELETE FROM player_positions WHERE demo_id = ?", (demo_id,))
        BATCH = 5000
        # Build each batch in-place to avoid holding the full list in memory
        # before the first insert (large demos = 500k+ rows ≈ 40 MB peak).
        for i in range(0, len(parsed.positions), BATCH):
            await conn.executemany(
                """INSERT INTO player_positions
                   (demo_id, tick, round_number, player_id, x, y, z, team_num, is_alive, yaw)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        demo_id,
                        pos.tick,
                        pos.round_number,
                        pos.player_id,
                        pos.x,
                        pos.y,
                        pos.z,
                        pos.team_num,
                        int(pos.is_alive),
                        getattr(pos, "yaw", 0.0),
                    )
                    for pos in parsed.positions[i : i + BATCH]
                ],
            )

        # events
        await conn.execute("DELETE FROM events WHERE demo_id = ?", (demo_id,))
        await conn.executemany(
            """INSERT INTO events
               (demo_id, tick, round_number, event_type, attacker_id, victim_id,
                weapon, headshot)
               VALUES (?,?,?,?,?,?,?,?)""",
            [
                (
                    demo_id,
                    e.tick,
                    e.round_number,
                    e.event_type,
                    e.attacker_id,
                    e.victim_id,
                    e.weapon,
                    int(e.headshot),
                )
                for e in parsed.events
            ],
        )

        # grenades
        await conn.execute("DELETE FROM grenades WHERE demo_id = ?", (demo_id,))
        if parsed.grenades:
            await conn.executemany(
                """INSERT INTO grenades
                   (demo_id, round_number, thrower_id, grenade_type, throw_tick,
                    detonate_tick, x, y, z, expire_tick, trajectory)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        demo_id,
                        g.round_number,
                        g.thrower_id,
                        g.grenade_type,
                        g.throw_tick,
                        g.detonate_tick,
                        g.x,
                        g.y,
                        g.z,
                        g.expire_tick,
                        json.dumps(g.trajectory) if g.trajectory else None,
                    )
                    for g in parsed.grenades
                ],
            )

        # player_state_events
        await conn.execute("DELETE FROM player_state_events WHERE demo_id = ?", (demo_id,))
        if parsed.player_state_events:
            await conn.executemany(
                """INSERT INTO player_state_events
                   (demo_id, tick, round_number, player_id, event_type, hp, armor, weapon)
                   VALUES (?,?,?,?,?,?,?,?)""",
                [
                    (
                        demo_id,
                        e.tick,
                        e.round_number,
                        e.player_id,
                        e.event_type,
                        e.hp,
                        e.armor,
                        e.weapon,
                    )
                    for e in parsed.player_state_events
                ],
            )

        await conn.commit()
    logger.info(
        "Stored demo %s (%d positions, %d events, %d grenades, %d state events)",
        demo_id,
        len(parsed.positions),
        len(parsed.events),
        len(parsed.grenades),
        len(parsed.player_state_events),
    )
