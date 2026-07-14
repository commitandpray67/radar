"""
API route package.

Assembles all sub-routers into a single `router` that main.py mounts at /api.
"""

from fastapi import APIRouter

from .demos import router as _demos_router
from .faceit import router as _faceit_router
from .health import router as _health_router
from .heatmap import router as _heatmap_router
from .maps import router as _maps_router
from .teams import router as _teams_router
from .voice import router as _voice_router

router = APIRouter()
router.include_router(_health_router)
router.include_router(_maps_router)
router.include_router(_demos_router)
router.include_router(_heatmap_router)
router.include_router(_voice_router)
router.include_router(_teams_router)
router.include_router(_faceit_router)
