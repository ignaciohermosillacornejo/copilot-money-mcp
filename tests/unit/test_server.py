"""
Unit tests for the MCP server implementation.
"""

import json
from pathlib import Path

import pytest
from mcp.types import TextContent

from copilot_money_mcp.server import CopilotMoneyServer


@pytest.fixture
def server_with_demo_db(demo_db_path):
    """Create server with demo database."""
    return CopilotMoneyServer(demo_db_path)


@pytest.fixture
def server_without_db():
    """Create server with non-existent database."""
    return CopilotMoneyServer(Path("/nonexistent/path"))


@pytest.mark.unit
def test_server_initialization_with_db(server_with_demo_db):
    """Test server initialization with valid database."""
    assert server_with_demo_db.db is not None
    assert server_with_demo_db.tools is not None
    assert server_with_demo_db.server is not None


@pytest.mark.unit
def test_server_initialization_without_db(server_without_db):
    """Test server initialization with invalid database."""
    assert server_without_db.db is not None
    assert server_without_db.tools is not None
    assert server_without_db.server is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_list_tools_handler(server_with_demo_db):
    """Test that list_tools handler is registered."""
    # The handlers are registered in __init__, so we can't directly call them
    # without accessing internals, but we can verify the server has them
    assert hasattr(server_with_demo_db.server, "list_tools")


@pytest.mark.unit
@pytest.mark.asyncio
async def test_call_tool_handler_exists(server_with_demo_db):
    """Test that call_tool handler is registered."""
    assert hasattr(server_with_demo_db.server, "call_tool")


@pytest.mark.unit
def test_server_with_default_db_path():
    """Test server initialization with default database path."""
    # This will use the default Copilot Money location
    server = CopilotMoneyServer()

    assert server.db is not None
    assert server.tools is not None
    # Database may or may not exist at default location
    # Just verify the server initializes properly


@pytest.mark.unit
def test_server_db_available_check(server_with_demo_db):
    """Test database availability check."""
    assert server_with_demo_db.db.is_available() is True


@pytest.mark.unit
def test_server_db_unavailable_check(server_without_db):
    """Test database unavailable check."""
    assert server_without_db.db.is_available() is False
