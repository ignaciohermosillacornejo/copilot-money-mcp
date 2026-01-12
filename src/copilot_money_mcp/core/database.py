"""
Database abstraction layer for Copilot Money data.

Provides filtered access to transactions and accounts with
proper error handling.
"""

from pathlib import Path
from typing import List, Optional

from copilot_money_mcp.core.decoder import decode_accounts, decode_transactions
from copilot_money_mcp.core.exceptions import DatabaseNotFoundError
from copilot_money_mcp.models.account import Account
from copilot_money_mcp.models.category import Category
from copilot_money_mcp.models.transaction import Transaction


class CopilotDatabase:
    """
    Abstraction layer for querying Copilot Money data.

    Wraps the decoder and provides filtering capabilities.
    """

    def __init__(self, db_path: Optional[Path] = None):
        """
        Initialize database connection.

        Args:
            db_path: Path to LevelDB database directory.
                    If None, uses default Copilot Money location.
        """
        if db_path is None:
            # Default Copilot Money location
            db_path = Path.home() / (
                "Library/Containers/com.copilot.production/Data/Library/"
                "Application Support/firestore/__FIRAPP_DEFAULT/"
                "copilot-production-22904/main"
            )

        self.db_path = db_path
        self._transactions: Optional[List[Transaction]] = None
        self._accounts: Optional[List[Account]] = None

    def is_available(self) -> bool:
        """Check if database exists and is accessible."""
        return self.db_path.exists() and any(self.db_path.glob("*.ldb"))

    def get_transactions(
        self,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        category: Optional[str] = None,
        merchant: Optional[str] = None,
        account_id: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        limit: int = 1000,
    ) -> List[Transaction]:
        """
        Get transactions with optional filters.

        Args:
            start_date: Filter by date >= this (YYYY-MM-DD)
            end_date: Filter by date <= this (YYYY-MM-DD)
            category: Filter by category_id (case-insensitive substring match)
            merchant: Filter by merchant name (case-insensitive substring match)
            account_id: Filter by account_id
            min_amount: Filter by amount >= this
            max_amount: Filter by amount <= this
            limit: Maximum number of transactions to return

        Returns:
            List of filtered transactions, sorted by date descending
        """
        # Lazy load transactions
        if self._transactions is None:
            self._transactions = decode_transactions(self.db_path)

        result = self._transactions[:]

        # Apply date range filter
        if start_date:
            result = [txn for txn in result if txn.date >= start_date]
        if end_date:
            result = [txn for txn in result if txn.date <= end_date]

        # Apply category filter (case-insensitive)
        if category:
            category_lower = category.lower()
            result = [
                txn
                for txn in result
                if txn.category_id and category_lower in txn.category_id.lower()
            ]

        # Apply merchant filter (case-insensitive, check display_name)
        if merchant:
            merchant_lower = merchant.lower()
            result = [
                txn
                for txn in result
                if merchant_lower in txn.display_name.lower()
            ]

        # Apply account ID filter
        if account_id:
            result = [txn for txn in result if txn.account_id == account_id]

        # Apply amount range filter
        if min_amount is not None:
            result = [txn for txn in result if txn.amount >= min_amount]
        if max_amount is not None:
            result = [txn for txn in result if txn.amount <= max_amount]

        # Apply limit
        return result[:limit]

    def search_transactions(self, query: str, limit: int = 50) -> List[Transaction]:
        """
        Free-text search of transactions.

        Searches in merchant name (display_name).

        Args:
            query: Search query (case-insensitive)
            limit: Maximum results

        Returns:
            List of matching transactions
        """
        # Lazy load transactions
        if self._transactions is None:
            self._transactions = decode_transactions(self.db_path)

        query_lower = query.lower()
        result = [
            txn
            for txn in self._transactions
            if query_lower in txn.display_name.lower()
        ]

        return result[:limit]

    def get_accounts(self, account_type: Optional[str] = None) -> List[Account]:
        """
        Get all accounts.

        Args:
            account_type: Optional filter by account type
                         (checking, savings, credit, investment)

        Returns:
            List of accounts
        """
        # Lazy load accounts
        if self._accounts is None:
            self._accounts = decode_accounts(self.db_path)

        result = self._accounts[:]

        # Apply account type filter if specified
        if account_type:
            account_type_lower = account_type.lower()
            result = [
                acc
                for acc in result
                if acc.account_type and account_type_lower in acc.account_type.lower()
            ]

        return result

    def get_categories(self) -> List[Category]:
        """
        Get all unique categories from transactions.

        Returns:
            List of unique categories
        """
        # Load transactions
        if self._transactions is None:
            self._transactions = decode_transactions(self.db_path)

        # Extract unique category IDs
        seen_categories = set()
        unique_categories = []

        for txn in self._transactions:
            if txn.category_id and txn.category_id not in seen_categories:
                seen_categories.add(txn.category_id)
                # Create Category object
                category = Category(
                    category_id=txn.category_id,
                    name=txn.category_id,  # Use category_id as name for now
                )
                unique_categories.append(category)

        return unique_categories
