"""
Shared constants, mutable state, and helpers used across route modules.

Path constants are read from environment variables so that the Electron
launcher can redirect data to the platform-appropriate user directory
(e.g. ~/.local/share/CS2Radar) without code changes.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import tempfile
from pathlib import Path

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


def _voice_dir(demo_id: str, round_number: int) -> Path:
    """Cache directory for voice OGG files for one round."""
    return _VOICE_CACHE / demo_id / str(round_number)


# ---------------------------------------------------------------------------
# Persistent job→demo mapping (survives server restarts)
# ---------------------------------------------------------------------------


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
_parse_jobs: dict[str, dict] = {}

# Prevents concurrent parses of the same demo (identified by content hash).
_parse_locks: dict[str, asyncio.Lock] = {}
_parse_locks_mu = asyncio.Lock()


async def _get_parse_lock(demo_id: str) -> asyncio.Lock:
    async with _parse_locks_mu:
        if demo_id not in _parse_locks:
            _parse_locks[demo_id] = asyncio.Lock()
        return _parse_locks[demo_id]
