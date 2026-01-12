"""
MCP tool definitions for Copilot Money data.

Exposes database functionality through the Model Context Protocol.
"""

from collections import defaultdict
from typing import Any, Dict, List, Optional

from copilot_money_mcp.core.database import CopilotDatabase
from copilot_money_mcp.utils.date_utils import parse_period


class CopilotMoneyTools:
    """Collection of MCP tools for querying Copilot Money data."""

    def __init__(self, database: CopilotDatabase):
        """
        Initialize tools with a database connection.

        Args:
            database: CopilotDatabase instance
        """
        self.db = database

    def get_transactions(
        self,
        period: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        category: Optional[str] = None,
        merchant: Optional[str] = None,
        account_id: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        limit: int = 100,
    ) -> Dict[str, Any]:
        """
        Get transactions with optional filters.

        Args:
            period: Period shorthand (this_month, last_30_days, ytd, etc.)
            start_date: Filter by date >= this (YYYY-MM-DD)
            end_date: Filter by date <= this (YYYY-MM-DD)
            category: Filter by category (case-insensitive substring match)
            merchant: Filter by merchant name (case-insensitive substring match)
            account_id: Filter by account_id
            min_amount: Filter by amount >= this
            max_amount: Filter by amount <= this
            limit: Maximum number of transactions to return (default: 100)

        Returns:
            Dict with transaction count and list of transactions
        """
        # If period is specified, parse it to start/end dates
        if period:
            start_date, end_date = parse_period(period)

        # Query transactions
        transactions = self.db.get_transactions(
            start_date=start_date,
            end_date=end_date,
            category=category,
            merchant=merchant,
            account_id=account_id,
            min_amount=min_amount,
            max_amount=max_amount,
            limit=limit,
        )

        # Convert to dict format
        return {
            "count": len(transactions),
            "transactions": [txn.model_dump(mode="json") for txn in transactions],
        }

    def search_transactions(
        self, query: str, limit: int = 50
    ) -> Dict[str, Any]:
        """
        Free-text search of transactions.

        Searches merchant names (display_name field).

        Args:
            query: Search query (case-insensitive)
            limit: Maximum results (default: 50)

        Returns:
            Dict with transaction count and list of matching transactions
        """
        transactions = self.db.search_transactions(query=query, limit=limit)

        return {
            "count": len(transactions),
            "transactions": [txn.model_dump(mode="json") for txn in transactions],
        }

    def get_accounts(
        self, account_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get all accounts with balances.

        Args:
            account_type: Optional filter by account type
                         (checking, savings, credit, investment)

        Returns:
            Dict with account count and list of accounts
        """
        accounts = self.db.get_accounts(account_type=account_type)

        # Calculate total balance
        total_balance = sum(acc.current_balance for acc in accounts)

        return {
            "count": len(accounts),
            "total_balance": total_balance,
            "accounts": [acc.model_dump(mode="json") for acc in accounts],
        }

    def get_spending_by_category(
        self,
        period: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        min_amount: Optional[float] = 0.0,
    ) -> Dict[str, Any]:
        """
        Get spending aggregated by category.

        Args:
            period: Period shorthand (this_month, last_30_days, ytd, etc.)
            start_date: Filter by date >= this (YYYY-MM-DD)
            end_date: Filter by date <= this (YYYY-MM-DD)
            min_amount: Only include expenses >= this (default: 0.0)

        Returns:
            Dict with spending breakdown by category
        """
        # If period is specified, parse it to start/end dates
        if period:
            start_date, end_date = parse_period(period)

        # Get transactions with filters
        transactions = self.db.get_transactions(
            start_date=start_date,
            end_date=end_date,
            min_amount=min_amount,
            limit=10000,  # High limit for aggregation
        )

        # Aggregate by category
        category_spending: Dict[str, float] = defaultdict(float)
        category_counts: Dict[str, int] = defaultdict(int)

        for txn in transactions:
            # Only count positive amounts (expenses)
            if txn.amount > 0:
                cat = txn.category_id or "Uncategorized"
                category_spending[cat] += txn.amount
                category_counts[cat] += 1

        # Convert to list of dicts, sorted by spending (descending)
        categories = [
            {
                "category": cat,
                "total_spending": round(amount, 2),
                "transaction_count": category_counts[cat],
            }
            for cat, amount in category_spending.items()
        ]
        categories.sort(key=lambda x: x["total_spending"], reverse=True)

        # Calculate totals
        total_spending = sum(cat["total_spending"] for cat in categories)

        return {
            "period": {"start_date": start_date, "end_date": end_date},
            "total_spending": round(total_spending, 2),
            "category_count": len(categories),
            "categories": categories,
        }

    def get_account_balance(self, account_id: str) -> Dict[str, Any]:
        """
        Get balance for a specific account.

        Args:
            account_id: Account ID to query

        Returns:
            Dict with account details and balance

        Raises:
            ValueError: If account_id is not found
        """
        accounts = self.db.get_accounts()

        # Find the account
        account = next((acc for acc in accounts if acc.account_id == account_id), None)

        if not account:
            raise ValueError(f"Account not found: {account_id}")

        return {
            "account_id": account.account_id,
            "name": account.display_name,
            "account_type": account.account_type,
            "current_balance": account.current_balance,
            "available_balance": account.available_balance,
            "mask": account.mask,
            "institution_name": account.institution_name,
        }


def create_tool_schemas() -> List[Dict[str, Any]]:
    """
    Create MCP tool schemas for all tools.

    Returns:
        List of tool schema definitions
    """
    return [
        {
            "name": "get_transactions",
            "description": (
                "Get transactions with optional filters. Supports date ranges, "
                "category, merchant, account, and amount filters. Use 'period' "
                "for common date ranges (this_month, last_30_days, ytd, etc.)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "period": {
                        "type": "string",
                        "description": (
                            "Period shorthand: this_month, last_month, "
                            "last_7_days, last_30_days, last_90_days, ytd, "
                            "this_year, last_year"
                        ),
                    },
                    "start_date": {
                        "type": "string",
                        "description": "Start date (YYYY-MM-DD)",
                        "pattern": r"^\d{4}-\d{2}-\d{2}$",
                    },
                    "end_date": {
                        "type": "string",
                        "description": "End date (YYYY-MM-DD)",
                        "pattern": r"^\d{4}-\d{2}-\d{2}$",
                    },
                    "category": {
                        "type": "string",
                        "description": "Filter by category (case-insensitive substring)",
                    },
                    "merchant": {
                        "type": "string",
                        "description": "Filter by merchant name (case-insensitive substring)",
                    },
                    "account_id": {
                        "type": "string",
                        "description": "Filter by account ID",
                    },
                    "min_amount": {
                        "type": "number",
                        "description": "Minimum transaction amount",
                    },
                    "max_amount": {
                        "type": "number",
                        "description": "Maximum transaction amount",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 100)",
                        "default": 100,
                    },
                },
            },
        },
        {
            "name": "search_transactions",
            "description": (
                "Free-text search of transactions by merchant name. "
                "Case-insensitive search."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of results (default: 50)",
                        "default": 50,
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "get_accounts",
            "description": (
                "Get all accounts with balances. Optionally filter by account type "
                "(checking, savings, credit, investment)."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "account_type": {
                        "type": "string",
                        "description": "Filter by account type",
                    },
                },
            },
        },
        {
            "name": "get_spending_by_category",
            "description": (
                "Get spending aggregated by category for a date range. "
                "Returns total spending per category, sorted by amount. "
                "Use 'period' for common date ranges."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "period": {
                        "type": "string",
                        "description": (
                            "Period shorthand: this_month, last_month, "
                            "last_7_days, last_30_days, last_90_days, ytd, "
                            "this_year, last_year"
                        ),
                    },
                    "start_date": {
                        "type": "string",
                        "description": "Start date (YYYY-MM-DD)",
                        "pattern": r"^\d{4}-\d{2}-\d{2}$",
                    },
                    "end_date": {
                        "type": "string",
                        "description": "End date (YYYY-MM-DD)",
                        "pattern": r"^\d{4}-\d{2}-\d{2}$",
                    },
                    "min_amount": {
                        "type": "number",
                        "description": "Only include expenses >= this (default: 0.0)",
                        "default": 0.0,
                    },
                },
            },
        },
        {
            "name": "get_account_balance",
            "description": "Get balance and details for a specific account by ID.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "account_id": {
                        "type": "string",
                        "description": "Account ID to query",
                    },
                },
                "required": ["account_id"],
            },
        },
    ]
