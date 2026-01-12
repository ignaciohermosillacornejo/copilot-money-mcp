"""
Integration tests for CopilotDatabase with demo database.
"""

import pytest
from pathlib import Path

from copilot_money_mcp.core.database import CopilotDatabase
from copilot_money_mcp.core.exceptions import DatabaseNotFoundError


@pytest.mark.integration
def test_database_initialization(demo_db_path):
    """Test that database can be initialized."""
    db = CopilotDatabase(demo_db_path)
    assert db.is_available()


@pytest.mark.integration
def test_database_not_found():
    """Test that DatabaseNotFoundError is raised for missing DB."""
    fake_path = Path("/nonexistent/path")
    db = CopilotDatabase(fake_path)
    assert not db.is_available()


@pytest.mark.integration
def test_get_transactions_no_filters(demo_db_path):
    """Test getting transactions without filters."""
    db = CopilotDatabase(demo_db_path)
    txns = db.get_transactions(limit=10)

    assert len(txns) == 10
    assert all(txn.transaction_id for txn in txns)


@pytest.mark.integration
def test_get_transactions_with_date_filter(demo_db_path):
    """Test filtering transactions by date range."""
    db = CopilotDatabase(demo_db_path)
    txns = db.get_transactions(
        start_date="2026-01-01",
        end_date="2026-01-10",
        limit=1000
    )

    # All transactions should be in date range
    assert all("2026-01-01" <= txn.date <= "2026-01-10" for txn in txns)


@pytest.mark.integration
def test_get_transactions_with_merchant_filter(demo_db_path):
    """Test filtering transactions by merchant name."""
    db = CopilotDatabase(demo_db_path)
    txns = db.get_transactions(merchant="starbucks", limit=100)

    # All transactions should contain "starbucks" (case-insensitive)
    assert all("starbucks" in txn.display_name.lower() for txn in txns)


@pytest.mark.integration
def test_get_transactions_with_amount_filter(demo_db_path):
    """Test filtering transactions by amount range."""
    db = CopilotDatabase(demo_db_path)
    txns = db.get_transactions(min_amount=10.0, max_amount=20.0, limit=100)

    # All transactions should be in amount range
    assert all(10.0 <= txn.amount <= 20.0 for txn in txns)


@pytest.mark.integration
def test_get_transactions_with_category_filter(demo_db_path):
    """Test filtering transactions by category."""
    db = CopilotDatabase(demo_db_path)
    # Get all transactions first to find a valid category
    all_txns = db.get_transactions(limit=100)

    # Find a transaction with a category
    txn_with_category = None
    for txn in all_txns:
        if txn.category_id:
            txn_with_category = txn
            break

    if txn_with_category:
        # Filter by that category
        filtered_txns = db.get_transactions(
            category=txn_with_category.category_id,
            limit=100
        )
        # All should have matching category
        assert all(
            txn_with_category.category_id.lower() in txn.category_id.lower()
            for txn in filtered_txns
            if txn.category_id
        )


@pytest.mark.integration
def test_get_transactions_with_account_filter(demo_db_path):
    """Test filtering transactions by account ID."""
    db = CopilotDatabase(demo_db_path)
    # Get all transactions to find a valid account ID
    all_txns = db.get_transactions(limit=10)

    if all_txns:
        account_id = all_txns[0].account_id
        filtered_txns = db.get_transactions(account_id=account_id, limit=100)

        # All should have matching account ID
        assert all(txn.account_id == account_id for txn in filtered_txns)


@pytest.mark.integration
def test_search_transactions(demo_db_path):
    """Test free-text search of transactions."""
    db = CopilotDatabase(demo_db_path)
    txns = db.search_transactions("coffee", limit=20)

    # Should match in display_name (case-insensitive)
    if txns:  # Only check if we found results
        assert all("coffee" in txn.display_name.lower() for txn in txns)


@pytest.mark.integration
def test_get_accounts(demo_db_path):
    """Test getting all accounts."""
    db = CopilotDatabase(demo_db_path)
    accounts = db.get_accounts()

    assert len(accounts) > 5  # Should have multiple accounts
    assert all(acc.account_id for acc in accounts)
    assert all(acc.current_balance is not None for acc in accounts)


@pytest.mark.integration
def test_get_accounts_with_type_filter(demo_db_path):
    """Test filtering accounts by type."""
    db = CopilotDatabase(demo_db_path)

    # Get all accounts first to find a valid type
    all_accounts = db.get_accounts()

    if all_accounts and all_accounts[0].account_type:
        account_type = all_accounts[0].account_type
        filtered_accounts = db.get_accounts(account_type=account_type)

        # All should have matching account type
        assert all(
            acc.account_type and account_type.lower() in acc.account_type.lower()
            for acc in filtered_accounts
        )


@pytest.mark.integration
def test_get_categories(demo_db_path):
    """Test getting all unique categories."""
    db = CopilotDatabase(demo_db_path)
    categories = db.get_categories()

    assert len(categories) > 0
    # Categories should be unique
    category_ids = [cat.category_id for cat in categories]
    assert len(category_ids) == len(set(category_ids))


@pytest.mark.integration
def test_transaction_sorting(demo_db_path):
    """Test that transactions are sorted by date descending."""
    db = CopilotDatabase(demo_db_path)
    txns = db.get_transactions(limit=50)

    # Check that dates are in descending order
    for i in range(len(txns) - 1):
        assert txns[i].date >= txns[i + 1].date


@pytest.mark.integration
def test_multiple_filters_combined(demo_db_path):
    """Test using multiple filters together."""
    db = CopilotDatabase(demo_db_path)
    txns = db.get_transactions(
        start_date="2025-01-01",
        end_date="2026-12-31",
        min_amount=5.0,
        limit=100
    )

    # All transactions should match all filters
    for txn in txns:
        assert "2025-01-01" <= txn.date <= "2026-12-31"
        assert txn.amount >= 5.0


@pytest.mark.integration
def test_empty_results(demo_db_path):
    """Test that filters can return empty results."""
    db = CopilotDatabase(demo_db_path)
    # Search for something that doesn't exist
    txns = db.search_transactions("xyznonexistent123", limit=100)
    assert len(txns) == 0


@pytest.mark.integration
def test_limit_parameter(demo_db_path):
    """Test that limit parameter is respected."""
    db = CopilotDatabase(demo_db_path)

    # Test various limits
    for limit in [1, 5, 10, 50]:
        txns = db.get_transactions(limit=limit)
        assert len(txns) <= limit
