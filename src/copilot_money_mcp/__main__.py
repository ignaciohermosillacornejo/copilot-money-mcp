"""
CLI entry point for Copilot Money MCP server.
"""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from copilot_money_mcp.server import run_server


def main() -> None:
    """Main entry point for the CLI."""
    parser = argparse.ArgumentParser(
        description="Copilot Money MCP Server - Expose financial data through MCP"
    )
    parser.add_argument(
        "--db-path",
        type=Path,
        help="Path to LevelDB database (default: Copilot Money's default location)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging",
    )

    args = parser.parse_args()

    # Configure logging
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        stream=sys.stderr,  # MCP uses stdout for protocol, so log to stderr
    )

    # Run the server
    try:
        asyncio.run(run_server(db_path=args.db_path))
    except KeyboardInterrupt:
        logging.info("Server stopped by user")
        sys.exit(0)
    except Exception as e:
        logging.exception(f"Server error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
