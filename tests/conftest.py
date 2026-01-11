"""
Pytest configuration and fixtures for copilot-money-mcp tests.
"""

from pathlib import Path
from typing import Generator

import pytest


@pytest.fixture(scope="session")
def demo_db_path() -> Path:
    """Path to demo database for testing."""
    path = Path(__file__).parent / "fixtures" / "demo_database"
    if not path.exists():
        pytest.skip(
            f"Demo database not found at {path}. "
            "Run 'python scripts/copy_demo_database.py' to set up test data."
        )
    return path


@pytest.fixture(scope="session")
def demo_db_exists(demo_db_path: Path) -> bool:
    """Check if demo database exists and has LevelDB files."""
    ldb_files = list(demo_db_path.glob("*.ldb"))
    return len(ldb_files) > 0
