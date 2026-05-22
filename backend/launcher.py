"""
PyInstaller entry point for the bundled CS2 Radar server.

Responsibilities:
  - Resolve writable user-data directories (DB, uploads, logs) via platformdirs
  - Pick a free TCP port and export it via stdout so Electron can read it
  - Start uvicorn
"""

import os
import socket
import sys
from pathlib import Path

import platformdirs
import uvicorn

APP_NAME = "CS2Radar"


def _user_data_dir() -> Path:
    d = Path(platformdirs.user_data_dir(APP_NAME, APP_NAME))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    data_dir = _user_data_dir()

    os.environ.setdefault("DB_PATH", str(data_dir / "demos.db"))
    os.environ.setdefault("UPLOAD_DIR", str(data_dir / "uploads"))
    os.environ.setdefault("HOST", "127.0.0.1")

    port = int(os.environ.get("PORT") or _pick_free_port())
    os.environ["PORT"] = str(port)

    logs_dir = data_dir / "logs"
    logs_dir.mkdir(exist_ok=True)
    os.environ.setdefault("LOG_DIR", str(logs_dir))

    # Tell the Electron parent which port and log dir to use.
    # Must flush immediately so Electron receives these before uvicorn output.
    print(f"PORT={port}", flush=True)
    print(f"LOGS_DIR={logs_dir}", flush=True)

    uvicorn.run("main:app", host="127.0.0.1", port=port, log_config=None)


if __name__ == "__main__":
    main()
