"""
End-to-end tests for the MCP server.

Tests the full server protocol including tool functionality.
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from copilot_money_mcp.core.database import CopilotDatabase
from copilot_money_mcp.server import CopilotMoneyServer
from copilot_money_mcp.tools.tools import CopilotMoneyTools


@pytest.fixture
def server(demo_db_path):
    """Create CopilotMoneyServer instance with demo database."""
    return CopilotMoneyServer(demo_db_path)


@pytest.fixture
def tools(demo_db_path):
    """Create CopilotMoneyTools instance for testing."""
    db = CopilotDatabase(demo_db_path)
    return CopilotMoneyTools(db)


@pytest.mark.e2e
def test_server_initialization(server):
    """Test that server can be initialized."""
    assert server.db is not None
    assert server.tools is not None
    assert server.server is not None


@pytest.mark.e2e
def test_server_database_available(server):
    """Test that server database is available."""
    assert server.db.is_available()


@pytest.mark.e2e
def test_get_transactions_tool_basic(tools):
    """Test basic get_transactions tool functionality."""
    result = tools.get_transactions(limit=10)

    assert "count" in result
    assert "transactions" in result
    assert result["count"] <= 10
    assert len(result["transactions"]) <= 10


@pytest.mark.e2e
def test_get_transactions_with_period(tools):
    """Test get_transactions with period parameter."""
    result = tools.get_transactions(period="last_30_days", limit=50)

    assert "count" in result
    assert result["count"] >= 0


@pytest.mark.e2e
def test_get_transactions_with_all_filters(tools):
    """Test get_transactions with multiple filters."""
    result = tools.get_transactions(
        start_date="2026-01-01",
        end_date="2026-01-31",
        min_amount=5.0,
        max_amount=100.0,
        limit=20,
    )

    for txn in result["transactions"]:
        assert "2026-01-01" <= txn["date"] <= "2026-01-31"
        assert 5.0 <= txn["amount"] <= 100.0


@pytest.mark.e2e
def test_search_transactions_tool(tools):
    """Test search_transactions tool."""
    result = tools.search_transactions(query="test", limit=10)

    assert "count" in result
    assert "transactions" in result
    assert result["count"] <= 10


@pytest.mark.e2e
def test_get_accounts_tool(tools):
    """Test get_accounts tool."""
    result = tools.get_accounts()

    assert "count" in result
    assert "total_balance" in result
    assert "accounts" in result
    assert result["count"] == len(result["accounts"])


@pytest.mark.e2e
def test_get_accounts_with_filter(tools):
    """Test get_accounts with type filter."""
    all_accounts = tools.get_accounts()

    if all_accounts["accounts"]:
        # Find an account type
        account_type = None
        for acc in all_accounts["accounts"]:
            if acc.get("account_type"):
                account_type = acc["account_type"]
                break

        if account_type:
            result = tools.get_accounts(account_type=account_type)
            assert result["count"] >= 0


@pytest.mark.e2e
def test_get_spending_by_category_tool(tools):
    """Test get_spending_by_category tool."""
    result = tools.get_spending_by_category(period="this_month")

    assert "period" in result
    assert "total_spending" in result
    assert "category_count" in result
    assert "categories" in result

    # Verify categories are sorted
    categories = result["categories"]
    for i in range(len(categories) - 1):
        assert categories[i]["total_spending"] >= categories[i + 1]["total_spending"]


@pytest.mark.e2e
def test_get_spending_by_category_with_date_range(tools):
    """Test get_spending_by_category with explicit dates."""
    result = tools.get_spending_by_category(
        start_date="2026-01-01", end_date="2026-01-31"
    )

    assert result["period"]["start_date"] == "2026-01-01"
    assert result["period"]["end_date"] == "2026-01-31"


@pytest.mark.e2e
def test_get_account_balance_tool(tools):
    """Test get_account_balance tool."""
    # First get accounts to find a valid ID
    accounts = tools.get_accounts()

    if accounts["accounts"]:
        account_id = accounts["accounts"][0]["account_id"]
        result = tools.get_account_balance(account_id=account_id)

        assert "account_id" in result
        assert "current_balance" in result
        assert result["account_id"] == account_id


@pytest.mark.e2e
def test_get_account_balance_not_found(tools):
    """Test get_account_balance with invalid account ID."""
    with pytest.raises(ValueError, match="Account not found"):
        tools.get_account_balance(account_id="nonexistent_123")


@pytest.mark.e2e
def test_database_unavailable():
    """Test tools behavior when database is unavailable."""
    fake_path = Path("/nonexistent/path")
    db = CopilotDatabase(fake_path)
    tools = CopilotMoneyTools(db)

    # Database is not available, but tools should still work
    # (they will just return empty results or error appropriately)
    assert db.is_available() is False


@pytest.mark.e2e
def test_tool_response_serialization(tools):
    """Test that all tool responses can be serialized to JSON."""
    # Test each tool returns JSON-serializable data
    tools_to_test = [
        (tools.get_transactions, {"limit": 5}),
        (tools.search_transactions, {"query": "test"}),
        (tools.get_accounts, {}),
        (tools.get_spending_by_category, {"period": "this_month"}),
    ]

    for tool_func, kwargs in tools_to_test:
        result = tool_func(**kwargs)
        # Should be able to serialize to JSON
        json_str = json.dumps(result)
        # Should be able to deserialize back
        deserialized = json.loads(json_str)
        assert isinstance(deserialized, dict)


@pytest.mark.e2e
def test_spending_aggregation_accuracy(tools):
    """Test that spending aggregation is mathematically correct."""
    result = tools.get_spending_by_category(period="last_90_days")

    # Calculate total from categories
    category_total = sum(cat["total_spending"] for cat in result["categories"])

    # Should match reported total (within rounding)
    assert abs(result["total_spending"] - category_total) < 0.01


@pytest.mark.e2e
def test_empty_results_handling(tools):
    """Test tools handle empty results gracefully."""
    # Search for something that doesn't exist
    result = tools.search_transactions(query="xyznonexistent123")
    assert result["count"] == 0
    assert result["transactions"] == []

    # Get transactions with impossible date range
    result = tools.get_transactions(
        start_date="1900-01-01", end_date="1900-01-31"
    )
    assert result["count"] == 0
    assert result["transactions"] == []


@pytest.mark.e2e
def test_large_limit_handling(tools):
    """Test tools handle large limits appropriately."""
    result = tools.get_transactions(limit=10000)

    # Should return some results but respect the database limit
    assert result["count"] >= 0
    assert result["count"] <= 10000


@pytest.mark.e2e
def test_date_filter_boundaries(tools):
    """Test date filter boundary conditions."""
    # Single day range
    result = tools.get_transactions(
        start_date="2026-01-15", end_date="2026-01-15", limit=100
    )

    # All transactions should be on that exact date
    for txn in result["transactions"]:
        assert txn["date"] == "2026-01-15"


@pytest.mark.e2e
def test_amount_filter_boundaries(tools):
    """Test amount filter boundary conditions."""
    # Exact amount match
    result = tools.get_transactions(
        min_amount=10.0, max_amount=10.0, limit=100
    )

    # All transactions should be exactly 10.0
    for txn in result["transactions"]:
        assert txn["amount"] == 10.0


@pytest.mark.e2e
def test_category_aggregation_counts(tools):
    """Test that category transaction counts are accurate."""
    result = tools.get_spending_by_category(period="last_90_days")

    # Each category should have at least 1 transaction
    for cat in result["categories"]:
        assert cat["transaction_count"] > 0
        assert cat["total_spending"] > 0


@pytest.mark.e2e
def test_account_balance_totals(tools):
    """Test that account balances sum correctly."""
    result = tools.get_accounts()

    # Calculate total from individual accounts
    calculated_total = sum(acc["current_balance"] for acc in result["accounts"])

    # Should match reported total (within rounding)
    assert abs(result["total_balance"] - calculated_total) < 0.01


@pytest.mark.e2e
def test_multiple_tool_calls_consistency(tools):
    """Test that multiple calls to the same tool return consistent results."""
    # Call get_transactions twice with same params
    result1 = tools.get_transactions(limit=10)
    result2 = tools.get_transactions(limit=10)

    # Results should be identical
    assert result1["count"] == result2["count"]

    # Transaction IDs should match
    ids1 = {txn["transaction_id"] for txn in result1["transactions"]}
    ids2 = {txn["transaction_id"] for txn in result2["transactions"]}
    assert ids1 == ids2
