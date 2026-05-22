"""
Integration tests for the FastAPI routes.

These tests use httpx + FastAPI's test client and stub out the database
so no real SQLite or demo file is required.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from httpx import ASGITransport, AsyncClient

from main import app

# ---------------------------------------------------------------------------
# /api/maps — no database needed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_maps_returns_known_maps() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/maps")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    names = {m["name"] for m in data}
    assert "de_dust2" in names
    assert "de_nuke" in names


@pytest.mark.asyncio
async def test_list_maps_structure() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/maps")
    data = resp.json()
    for entry in data:
        assert "name" in entry
        assert "is_multilevel" in entry
        assert "layers" in entry
        assert isinstance(entry["layers"], list)


@pytest.mark.asyncio
async def test_nuke_is_multilevel_in_api() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/maps")
    nuke = next(m for m in resp.json() if m["name"] == "de_nuke")
    assert nuke["is_multilevel"] is True
    assert len(nuke["layers"]) >= 2


# ---------------------------------------------------------------------------
# /api/demos — empty database
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_demos_empty() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/demos")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


@pytest.mark.asyncio
async def test_get_nonexistent_demo_returns_404() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/demos/nonexistent_demo_id")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# /api/demos/upload — bad file type
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_non_dem_file_returns_400() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/demos/upload",
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
    assert resp.status_code == 400
