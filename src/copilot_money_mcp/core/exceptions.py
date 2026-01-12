"""
Custom exceptions for Copilot Money MCP server.
"""


class CopilotMoneyError(Exception):
    """Base exception for Copilot Money MCP errors."""
    pass


class DatabaseNotFoundError(CopilotMoneyError):
    """Raised when Copilot Money database cannot be found."""
    pass


class DatabaseLockedError(CopilotMoneyError):
    """Raised when database is locked (app is running)."""
    pass


class DecodeError(CopilotMoneyError):
    """Raised when data cannot be decoded from database."""
    pass
