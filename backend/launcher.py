"""
PyInstaller entry point for the bundled CS2 Radar server.

Responsibilities:
  - Resolve writable user-data directories (DB, uploads, logs) via platformdirs
  - Pick a free TCP port and report it to the Electron parent via stdout
  - Start uvicorn
"""

import os
import socket
import sys
from pathlib import Path

import platformdirs
import uvicorn

APP_NAME = "CS2Radar"

# Maximum file upload size accepted by the server (500 MB).
# Exposed as an env var so it can be overridden without a rebuild.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "500")) * 1_000_000


def _user_data_dir() -> Path:
    """Return (and create) the platform-appropriate writable data directory."""
    try:
        d = Path(platformdirs.user_data_dir(APP_NAME, APP_NAME))
        d.mkdir(parents=True, exist_ok=True)
        return d
    except Exception as exc:
        # If the normal user-data dir is inaccessible (rare: corrupted home,
        # read-only filesystem, extreme permissions), fall back to /tmp so the
        # app can still start rather than crashing on launch.
        import tempfile
        fallback = Path(tempfile.gettempdir()) / "cs2radar_data"
        fallback.mkdir(parents=True, exist_ok=True)
        print(
            f"WARNING: could not create user data dir ({exc}); "
            f"falling back to {fallback}",
            file=sys.stderr,
        )
        return fallback


def _pick_free_port() -> int:
    """Bind to an OS-assigned free port and return the port number.

    SO_REUSEADDR is set so that if the same port number is returned by
    successive calls (unlikely), uvicorn can still bind it.  There is a
    small TOCTOU window between socket close and uvicorn bind, but in
    practice this is negligible on loopback.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    data_dir = _user_data_dir()

    os.environ.setdefault("DATA_DIR",   str(data_dir))
    os.environ.setdefault("DB_PATH",    str(data_dir / "demos.db"))
    os.environ.setdefault("UPLOAD_DIR", str(data_dir / "uploads"))

    logs_dir = data_dir / "logs"
    logs_dir.mkdir(exist_ok=True)
    os.environ.setdefault("LOG_DIR", str(logs_dir))

    # Honour PORT from environment (useful for testing), else pick a free one.
    port = int(os.environ.get("PORT") or _pick_free_port())
    os.environ["PORT"] = str(port)

    # Announce port and log dir to the Electron parent process.
    # These lines must be flushed immediately — Electron reads them before
    # uvicorn starts writing its own startup logs.
    print(f"PORT={port}", flush=True)
    print(f"LOGS_DIR={logs_dir}", flush=True)

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        reload=False,       # never watch for file changes in a frozen bundle
        workers=1,          # single worker — SQLite doesn't support multiprocess writes
        access_log=False,   # reduce log noise; FastAPI middleware handles request logging
        log_config=None,    # use the logging config set up by main.py
    )


if __name__ == "__main__":
    main()
