"""
Shared pytest fixtures.

Sets DB_PATH to a temporary SQLite database for tests so the test suite
never touches the production database.
"""

import os

import pytest
import pytest_asyncio


@pytest.fixture(scope="session", autouse=True)
def temp_db(tmp_path_factory):
    """Point the database at a temp file for the test session."""
    db_file = tmp_path_factory.mktemp("data") / "test_demos.db"
    os.environ["DB_PATH"] = str(db_file)
    yield db_file
    # Cleanup handled by tmp_path_factory


@pytest_asyncio.fixture(scope="session", autouse=True)
async def init_test_db(temp_db):
    """Initialise the SQLite schema before any API tests run."""
    from db.database import init_db

    await init_db()
