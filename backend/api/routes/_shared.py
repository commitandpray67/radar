"""
Shared constants, mutable state, and helpers used across route modules.

Path constants are read from environment variables so that the Electron
launcher can redirect data to the platform-appropriate user directory
(e.g. ~/.local/share/CS2Radar) without code changes.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import math
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import BinaryIO

# ---------------------------------------------------------------------------
# Configurable data paths
# ---------------------------------------------------------------------------

_DATA_DIR = Path(os.environ.get("DATA_DIR", "/tmp/cs2radar"))
_UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR", str(_DATA_DIR / "uploads")))
_JOB_MAP_FILE = _DATA_DIR / "jobs" / "job_map.json"
_DEMO_STORE = _DATA_DIR / "demos"
_VOICE_CACHE = _DATA_DIR / "voice"
_MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "2000")) * 1_000_000


def _demo_file_path(demo_id: str) -> Path:
    """Persistent location for a demo file (kept after parse for voice extraction)."""
    return _DEMO_STORE / f"{demo_id}.dem"


def _voice_dir(demo_id: str, round_number: int, extended: bool = False) -> Path:
    """Cache directory for voice OGG files for one round.

    Extended windows (round + post-round restart delay) are cached in a
    separate ``{round}_ext`` sub-directory so their clips never collide with
    the standard round-only clips.
    """
    sub = f"{round_number}_ext" if extended else str(round_number)
    return _VOICE_CACHE / demo_id / sub


# ---------------------------------------------------------------------------
# Persistent job→demo mapping (survives server restarts)
# ---------------------------------------------------------------------------


# Keep only the newest N job→demo mappings so the file can't grow forever.
_JOB_MAP_CAP = 500


def _persist_job_mapping(job_id: str, demo_id: str) -> None:
    """Write job_id→demo_id to disk so parse-status can recover after restart."""
    try:
        data: dict = {}
        if _JOB_MAP_FILE.exists():
            try:
                data = json.loads(_JOB_MAP_FILE.read_text())
            except Exception:
                data = {}
        data[job_id] = demo_id
        if len(data) > _JOB_MAP_CAP:
            # dicts preserve insertion order — keep the most recent entries.
            data = dict(list(data.items())[-_JOB_MAP_CAP:])
        _JOB_MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: a crash mid-write must not corrupt the whole map.
        fd, tmp = tempfile.mkstemp(dir=str(_JOB_MAP_FILE.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(data))
            os.replace(tmp, _JOB_MAP_FILE)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        pass  # non-fatal


def _load_job_demo_id(job_id: str) -> str | None:
    """Look up demo_id for a job_id from the persistent mapping file."""
    try:
        if _JOB_MAP_FILE.exists():
            data = json.loads(_JOB_MAP_FILE.read_text())
            return data.get(job_id)
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------


def _sanitize_nan(obj):
    """Recursively replace NaN/Inf floats with None (→ JSON null).

    Using None rather than 0 prevents bogus (0, 0) coordinates appearing on
    the map when a position field is missing or infinite.
    """
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nan(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# In-memory parse state
# ---------------------------------------------------------------------------

# job_id → status dict written by the upload handler and read by the SSE stream.
# All mutations happen in the same asyncio event loop, so no extra locking is
# needed for the dict itself; only the per-demo parse locks use asyncio.Lock.
# Finished entries carry a "_finished_at" timestamp and are swept after
# _JOB_TTL_SECONDS so the dict cannot grow without bound.
_parse_jobs: dict[str, dict] = {}
_JOB_TTL_SECONDS = 3600.0

# Strong references to in-flight parse tasks: a bare create_task() result can
# be garbage-collected mid-run if nothing holds it.
_bg_tasks: set[asyncio.Task] = set()


def _mark_job_finished(job: dict) -> None:
    """Stamp a terminal job entry for TTL-based sweeping."""
    job["_finished_at"] = time.time()


def _sweep_finished_jobs() -> None:
    """Drop terminal job entries older than the TTL."""
    cutoff = time.time() - _JOB_TTL_SECONDS
    stale = [
        k for k, v in _parse_jobs.items()
        if v.get("_finished_at") is not None and v["_finished_at"] < cutoff
    ]
    for k in stale:
        _parse_jobs.pop(k, None)


def _public_job(job: dict) -> dict:
    """Job entry without internal (underscore-prefixed) bookkeeping keys."""
    return {k: v for k, v in job.items() if not k.startswith("_")}

# Prevents concurrent parses of the same demo (identified by content hash).
_parse_locks: dict[str, asyncio.Lock] = {}
_parse_locks_mu = asyncio.Lock()


async def _get_parse_lock(demo_id: str) -> asyncio.Lock:
    async with _parse_locks_mu:
        if demo_id not in _parse_locks:
            _parse_locks[demo_id] = asyncio.Lock()
        return _parse_locks[demo_id]


# ---------------------------------------------------------------------------
# Demo decompression (gzip / zstd) — CS2 demos from FACEIT arrive compressed
# ---------------------------------------------------------------------------

_GZIP_MAGIC = b"\x1f\x8b"
_ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
_DECOMP_CHUNK = 1024 * 1024  # 1 MB


class DecompressionError(Exception):
    """Raised when a compressed demo cannot be decompressed."""


def _copy_capped(reader: BinaryIO, out: BinaryIO, cap: int) -> None:
    """Stream ``reader`` into ``out`` in chunks, raising past ``cap`` bytes."""
    written = 0
    while True:
        chunk = reader.read(_DECOMP_CHUNK)
        if not chunk:
            break
        written += len(chunk)
        if written > cap:
            raise DecompressionError(
                f"Decompressed demo too large (> {cap // 1_000_000} MB)."
            )
        out.write(chunk)


def compression_kind(path: Path) -> str | None:
    """Return 'gzip', 'zstd', or None based on the file's magic bytes."""
    try:
        with path.open("rb") as f:
            magic = f.read(4)
    except OSError:
        return None
    if magic[:2] == _GZIP_MAGIC:
        return "gzip"
    if magic[:4] == _ZSTD_MAGIC:
        return "zstd"
    return None


def decompress_demo(src: Path, dest: Path, *, cap: int | None = None) -> None:
    """Write a raw demo at ``dest`` from ``src``, decompressing gzip/zstd.

    Detection is by magic bytes, not the file extension.  A non-compressed
    source is copied through unchanged.  Enforces the size cap on the
    decompressed stream.  Blocking (IO/CPU) — call via an executor.
    """
    cap = _MAX_UPLOAD_BYTES if cap is None else cap
    kind = compression_kind(src)
    if kind == "gzip":
        with gzip.open(src, "rb") as gz, dest.open("wb") as out:
            _copy_capped(gz, out, cap)
    elif kind == "zstd":
        try:
            import zstandard as zstd
        except ImportError as exc:  # pragma: no cover - dependency present in prod
            raise DecompressionError(
                "This build cannot open .zst demos (zstandard is not installed)."
            ) from exc
        dctx = zstd.ZstdDecompressor()
        with src.open("rb") as fin, dest.open("wb") as out:
            with dctx.stream_reader(fin) as reader:
                _copy_capped(reader, out, cap)
    else:
        shutil.copyfile(src, dest)
