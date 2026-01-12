"""
MCP server for Copilot Money.

Exposes financial data through the Model Context Protocol.
"""

import logging
from pathlib import Path
from typing import Any, Optional

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

from copilot_money_mcp.core.database import CopilotDatabase
from copilot_money_mcp.core.exceptions import DatabaseNotFoundError
from copilot_money_mcp.tools.tools import CopilotMoneyTools, create_tool_schemas

logger = logging.getLogger(__name__)


class CopilotMoneyServer:
    """MCP server for Copilot Money data."""

    def __init__(self, db_path: Optional[Path] = None):
        """
        Initialize the MCP server.

        Args:
            db_path: Optional path to LevelDB database.
                    If None, uses default Copilot Money location.
        """
        self.db = CopilotDatabase(db_path)
        self.tools = CopilotMoneyTools(self.db)
        self.server = Server("copilot-money-mcp")

        # Register handlers
        self._register_handlers()

    def _register_handlers(self) -> None:
        """Register MCP protocol handlers."""

        @self.server.list_tools()
        async def list_tools() -> list[Tool]:
            """List available tools."""
            schemas = create_tool_schemas()
            return [
                Tool(
                    name=schema["name"],
                    description=schema["description"],
                    inputSchema=schema["inputSchema"],
                )
                for schema in schemas
            ]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
            """Handle tool calls."""
            # Check if database is available
            if not self.db.is_available():
                error_msg = (
                    "Database not available. Please ensure Copilot Money is installed "
                    "and has created local data, or provide a custom database path."
                )
                return [TextContent(type="text", text=error_msg)]

            try:
                # Route to appropriate tool handler
                if name == "get_transactions":
                    result = self.tools.get_transactions(**arguments)
                elif name == "search_transactions":
                    result = self.tools.search_transactions(**arguments)
                elif name == "get_accounts":
                    result = self.tools.get_accounts(**arguments)
                elif name == "get_spending_by_category":
                    result = self.tools.get_spending_by_category(**arguments)
                elif name == "get_account_balance":
                    result = self.tools.get_account_balance(**arguments)
                else:
                    return [
                        TextContent(
                            type="text",
                            text=f"Unknown tool: {name}",
                        )
                    ]

                # Format response
                import json

                return [
                    TextContent(
                        type="text",
                        text=json.dumps(result, indent=2),
                    )
                ]

            except ValueError as e:
                # Handle validation errors (e.g., account not found)
                return [TextContent(type="text", text=f"Error: {str(e)}")]
            except Exception as e:
                logger.exception(f"Error executing tool {name}")
                return [
                    TextContent(
                        type="text",
                        text=f"Error executing tool: {str(e)}",
                    )
                ]

    async def run(self) -> None:  # pragma: no cover
        """Run the MCP server using stdio transport."""
        async with stdio_server() as (read_stream, write_stream):
            await self.server.run(
                read_stream,
                write_stream,
                self.server.create_initialization_options(),
            )


async def run_server(db_path: Optional[Path] = None) -> None:  # pragma: no cover
    """
    Run the Copilot Money MCP server.

    Args:
        db_path: Optional path to LevelDB database.
                If None, uses default Copilot Money location.
    """
    server = CopilotMoneyServer(db_path)
    await server.run()
