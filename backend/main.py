"""
CS2 Demo Radar — FastAPI application entry point.
"""

import json
import logging
import logging.handlers
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles


def _sanitize_nan(obj):
    """Recursively replace NaN/Inf floats with 0 to make JSON-safe."""
    if isinstance(obj, float):
        return 0.0 if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, dict):
        return {k: _sanitize_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_nan(v) for v in obj]
    return obj


class NaNSafeJSONResponse(JSONResponse):
    """JSONResponse that converts NaN/Inf floats to 0 before serialising."""

    def render(self, content) -> bytes:  # type: ignore[override]
        return json.dumps(
            _sanitize_nan(content),
            ensure_ascii=False,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
        ).encode("utf-8")


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_log_dir = Path(__file__).parent / "logs"
_log_dir.mkdir(exist_ok=True)
_log_file = _log_dir / "backend.log"

_file_handler = logging.handlers.RotatingFileHandler(
    _log_file, maxBytes=5_000_000, backupCount=3, encoding="utf-8"
)
_fmt = logging.Formatter("%(asctime)s  %(levelname)-8s  %(name)s — %(message)s")
_file_handler.setFormatter(_fmt)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    handlers=[logging.StreamHandler(), _file_handler],
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

def _cleanup_stale_uploads() -> None:
    """Remove any temp upload files left over from a previous crashed run."""
    upload_dir = Path(os.environ.get("UPLOAD_DIR", "/tmp/cs2radar_uploads"))
    if not upload_dir.exists():
        return
    removed = 0
    for f in upload_dir.glob("*.dem"):
        try:
            f.unlink()
            removed += 1
        except OSError:
            pass
    if removed:
        logger.info("Cleaned up %d stale upload file(s) from %s", removed, upload_dir)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    _cleanup_stale_uploads()
    logger.info("Initialising database")
    from db.database import init_db
    await init_db()
    logger.info("CS2 Radar backend ready")
    yield
    logger.info("Shutting down")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

# CORS origins: defaults to localhost dev servers; override via ALLOWED_ORIGINS
# env var as a comma-separated list, e.g.:
#   ALLOWED_ORIGINS=https://radar.example.com,https://www.radar.example.com
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS: list[str] = (
    [o.strip() for o in _raw_origins.split(",") if o.strip()]
    if _raw_origins
    else [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]
)

from api.routes import router  # noqa: E402

app = FastAPI(
    title="CS2 Demo Radar",
    version="1.0.0",
    description="Parse CS2 demo files and visualise player positions on the radar.",
    lifespan=lifespan,
    default_response_class=NaNSafeJSONResponse,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)

app.include_router(router, prefix="/api")

# Serve radar map images
_maps_candidates = [
    Path(__file__).parent.parent / "frontend" / "public" / "maps",
    Path(__file__).parent.parent / "frontend" / "dist" / "maps",
]
for _maps_dir in _maps_candidates:
    if _maps_dir.exists():
        app.mount("/maps", StaticFiles(directory=str(_maps_dir)), name="maps")
        logger.info("Serving radar images from %s", _maps_dir)
        break

# Serve built frontend
frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    # reload=True is intentionally omitted — use a process manager for auto-reload
    uvicorn.run("main:app", host=host, port=port)
