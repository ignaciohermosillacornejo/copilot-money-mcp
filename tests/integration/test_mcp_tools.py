"""
Integration tests for MCP tools with demo database.
"""

import pytest

from copilot_money_mcp.core.database import CopilotDatabase
from copilot_money_mcp.tools.tools import CopilotMoneyTools, create_tool_schemas


@pytest.fixture
def tools(demo_db_path):
    """Create CopilotMoneyTools instance with demo database."""
    db = CopilotDatabase(demo_db_path)
    return CopilotMoneyTools(db)


@pytest.mark.integration
def test_get_transactions_basic(tools):
    """Test basic get_transactions tool."""
    result = tools.get_transactions(limit=10)

    assert "count" in result
    assert "transactions" in result
    assert result["count"] == len(result["transactions"])
    assert result["count"] <= 10

    # Verify transaction structure
    if result["transactions"]:
        txn = result["transactions"][0]
        assert "transaction_id" in txn
        assert "amount" in txn
        assert "date" in txn


@pytest.mark.integration
def test_get_transactions_with_period(tools):
    """Test get_transactions with period parameter."""
    result = tools.get_transactions(period="last_30_days", limit=100)

    assert "count" in result
    assert result["count"] >= 0

    # Verify all transactions are within the last 30 days
    from datetime import datetime, timedelta

    today = datetime.now()
    thirty_days_ago = (today - timedelta(days=30)).strftime("%Y-%m-%d")

    for txn in result["transactions"]:
        assert txn["date"] >= thirty_days_ago


@pytest.mark.integration
def test_get_transactions_with_filters(tools):
    """Test get_transactions with multiple filters."""
    result = tools.get_transactions(
        start_date="2026-01-01",
        end_date="2026-01-31",
        min_amount=5.0,
        limit=50,
    )

    # Verify filters are applied
    for txn in result["transactions"]:
        assert "2026-01-01" <= txn["date"] <= "2026-01-31"
        assert txn["amount"] >= 5.0


@pytest.mark.integration
def test_get_transactions_with_merchant_filter(tools):
    """Test get_transactions with merchant filter."""
    result = tools.get_transactions(merchant="coffee", limit=20)

    # Verify merchant filter
    for txn in result["transactions"]:
        # Check either name or original_name contains "coffee"
        name_fields = [
            txn.get("name", ""),
            txn.get("original_name", ""),
        ]
        assert any(
            "coffee" in str(field).lower() for field in name_fields if field
        )


@pytest.mark.integration
def test_get_transactions_with_category_filter(tools):
    """Test get_transactions with category filter."""
    # First get some transactions to find a valid category
    all_result = tools.get_transactions(limit=50)

    # Find a transaction with a category
    category = None
    for txn in all_result["transactions"]:
        if txn.get("category_id"):
            category = txn["category_id"]
            break

    if category:
        result = tools.get_transactions(category=category, limit=20)

        # Verify category filter
        for txn in result["transactions"]:
            assert txn.get("category_id")
            assert category.lower() in txn["category_id"].lower()


@pytest.mark.integration
def test_search_transactions(tools):
    """Test search_transactions tool."""
    result = tools.search_transactions(query="test", limit=20)

    assert "count" in result
    assert "transactions" in result
    assert result["count"] == len(result["transactions"])
    assert result["count"] <= 20


@pytest.mark.integration
def test_search_transactions_case_insensitive(tools):
    """Test that search is case-insensitive."""
    result1 = tools.search_transactions(query="STARBUCKS", limit=10)
    result2 = tools.search_transactions(query="starbucks", limit=10)

    # Results should be the same (case-insensitive)
    assert result1["count"] == result2["count"]


@pytest.mark.integration
def test_get_accounts(tools):
    """Test get_accounts tool."""
    result = tools.get_accounts()

    assert "count" in result
    assert "total_balance" in result
    assert "accounts" in result
    assert result["count"] == len(result["accounts"])

    # Verify total_balance is correct
    calculated_total = sum(acc["current_balance"] for acc in result["accounts"])
    assert abs(result["total_balance"] - calculated_total) < 0.01

    # Verify account structure
    if result["accounts"]:
        acc = result["accounts"][0]
        assert "account_id" in acc
        assert "current_balance" in acc


@pytest.mark.integration
def test_get_accounts_with_type_filter(tools):
    """Test get_accounts with account type filter."""
    # First get all accounts to find a valid type
    all_result = tools.get_accounts()

    if all_result["accounts"]:
        # Find an account with a type
        account_type = None
        for acc in all_result["accounts"]:
            if acc.get("account_type"):
                account_type = acc["account_type"]
                break

        if account_type:
            result = tools.get_accounts(account_type=account_type)

            # Verify type filter
            for acc in result["accounts"]:
                if acc.get("account_type"):
                    assert account_type.lower() in acc["account_type"].lower()


@pytest.mark.integration
def test_get_spending_by_category_basic(tools):
    """Test basic get_spending_by_category tool."""
    result = tools.get_spending_by_category(period="this_month")

    assert "period" in result
    assert "total_spending" in result
    assert "category_count" in result
    assert "categories" in result

    # Verify period is set
    assert result["period"]["start_date"]
    assert result["period"]["end_date"]

    # Verify categories structure
    for cat in result["categories"]:
        assert "category" in cat
        assert "total_spending" in cat
        assert "transaction_count" in cat
        assert cat["total_spending"] >= 0
        assert cat["transaction_count"] > 0


@pytest.mark.integration
def test_get_spending_by_category_sorted(tools):
    """Test that spending by category is sorted descending."""
    result = tools.get_spending_by_category(period="last_90_days")

    # Verify categories are sorted by spending (descending)
    categories = result["categories"]
    for i in range(len(categories) - 1):
        assert categories[i]["total_spending"] >= categories[i + 1]["total_spending"]


@pytest.mark.integration
def test_get_spending_by_category_with_date_range(tools):
    """Test get_spending_by_category with explicit date range."""
    result = tools.get_spending_by_category(
        start_date="2026-01-01", end_date="2026-01-31"
    )

    assert result["period"]["start_date"] == "2026-01-01"
    assert result["period"]["end_date"] == "2026-01-31"

    # Verify total_spending matches sum of categories
    calculated_total = sum(cat["total_spending"] for cat in result["categories"])
    assert abs(result["total_spending"] - calculated_total) < 0.01


@pytest.mark.integration
def test_get_spending_by_category_with_min_amount(tools):
    """Test get_spending_by_category with min_amount filter."""
    result = tools.get_spending_by_category(
        period="last_30_days", min_amount=10.0
    )

    # Result should only include expenses >= 10.0
    # Note: The tool aggregates by category, so we can't directly verify
    # individual transaction amounts, but we can verify structure
    assert "categories" in result
    assert isinstance(result["categories"], list)


@pytest.mark.integration
def test_get_account_balance(tools):
    """Test get_account_balance tool."""
    # First get accounts to find a valid account_id
    accounts_result = tools.get_accounts()

    if accounts_result["accounts"]:
        account_id = accounts_result["accounts"][0]["account_id"]

        result = tools.get_account_balance(account_id=account_id)

        assert "account_id" in result
        assert "name" in result
        assert "account_type" in result
        assert "current_balance" in result
        assert result["account_id"] == account_id


@pytest.mark.integration
def test_get_account_balance_not_found(tools):
    """Test get_account_balance with invalid account_id."""
    with pytest.raises(ValueError, match="Account not found"):
        tools.get_account_balance(account_id="nonexistent_account_123")


@pytest.mark.integration
def test_tool_schemas():
    """Test that tool schemas are properly defined."""
    schemas = create_tool_schemas()

    assert len(schemas) == 5

    # Verify all required tool names are present
    tool_names = {schema["name"] for schema in schemas}
    expected_names = {
        "get_transactions",
        "search_transactions",
        "get_accounts",
        "get_spending_by_category",
        "get_account_balance",
    }
    assert tool_names == expected_names

    # Verify each schema has required fields
    for schema in schemas:
        assert "name" in schema
        assert "description" in schema
        assert "inputSchema" in schema
        assert "type" in schema["inputSchema"]
        assert "properties" in schema["inputSchema"]


@pytest.mark.integration
def test_transaction_response_format(tools):
    """Test that transaction responses are properly formatted."""
    result = tools.get_transactions(limit=1)

    if result["transactions"]:
        txn = result["transactions"][0]

        # Verify required fields are present
        assert "transaction_id" in txn
        assert "amount" in txn
        assert "date" in txn

        # Verify date format
        import re

        assert re.match(r"^\d{4}-\d{2}-\d{2}$", txn["date"])

        # Verify amount is a number
        assert isinstance(txn["amount"], (int, float))


@pytest.mark.integration
def test_account_response_format(tools):
    """Test that account responses are properly formatted."""
    result = tools.get_accounts()

    if result["accounts"]:
        acc = result["accounts"][0]

        # Verify required fields
        assert "account_id" in acc
        assert "current_balance" in acc

        # Verify balance is a number
        assert isinstance(acc["current_balance"], (int, float))


@pytest.mark.integration
def test_empty_results(tools):
    """Test tools with filters that return no results."""
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
