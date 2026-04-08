"""
CS2 Demo Radar — FastAPI application entry point.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.routes import router
from db.database import init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    logger.info("Initialising database")
    await init_db()
    logger.info("CS2 Radar backend ready")
    yield
    logger.info("Shutting down")


app = FastAPI(
    title="CS2 Demo Radar",
    version="1.0.0",
    description="Parse CS2 demo files and visualise player positions on the radar.",
    lifespan=lifespan,
)

# Allow the Vite dev server (localhost:5173) to talk to the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",  # Vite preview
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")

# Serve radar map images from backend so both dev and prod modes work.
# The frontend requests /maps/<name>_radar.png; we look in:
#   1. frontend/public/maps/   (source tree, dev mode)
#   2. frontend/dist/maps/     (after npm run build, prod mode)
# Whichever exists first wins; images can be placed in either location.
_maps_candidates = [
    Path(__file__).parent.parent / "frontend" / "public" / "maps",
    Path(__file__).parent.parent / "frontend" / "dist" / "maps",
]
for _maps_dir in _maps_candidates:
    if _maps_dir.exists():
        app.mount("/maps", StaticFiles(directory=str(_maps_dir)), name="maps")
        logger.info("Serving radar images from %s", _maps_dir)
        break

# Serve the built frontend from the backend process in production
frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=[str(Path(__file__).parent)],
    )
