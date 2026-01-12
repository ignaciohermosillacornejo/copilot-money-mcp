"""
Core functionality for Copilot Money MCP.
"""

from copilot_money_mcp.core.database import CopilotDatabase
from copilot_money_mcp.core.decoder import decode_accounts, decode_transactions
from copilot_money_mcp.core.exceptions import (
    CopilotMoneyError,
    DatabaseLockedError,
    DatabaseNotFoundError,
    DecodeError,
)

__all__ = [
    "CopilotDatabase",
    "decode_accounts",
    "decode_transactions",
    "CopilotMoneyError",
    "DatabaseLockedError",
    "DatabaseNotFoundError",
    "DecodeError",
]
