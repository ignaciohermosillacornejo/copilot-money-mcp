"""
Integration tests for decoder with real demo database.
"""

import pytest

from copilot_money_mcp.core.decoder import decode_accounts, decode_transactions


@pytest.mark.integration
def test_decode_transactions_from_demo_db(demo_db_path):  # type: ignore[no-untyped-def]
    """Test that we can decode transactions from the demo database."""
    transactions = decode_transactions(demo_db_path)

    # Should extract a significant number of transactions
    assert len(transactions) > 5000, f"Expected >5000 transactions, got {len(transactions)}"

    # Check first transaction has required fields
    txn = transactions[0]
    assert txn.transaction_id is not None
    assert txn.amount != 0
    assert txn.date is not None
    assert txn.display_name != "Unknown"

    print(f"\nExtracted {len(transactions)} transactions")
    print(f"First transaction: {txn.date} | {txn.display_name} | ${txn.amount}")


@pytest.mark.integration
def test_decode_accounts_from_demo_db(demo_db_path):  # type: ignore[no-untyped-def]
    """Test that we can decode accounts from the demo database."""
    accounts = decode_accounts(demo_db_path)

    # Should extract multiple accounts
    assert len(accounts) > 5, f"Expected >5 accounts, got {len(accounts)}"

    # Check first account has required fields
    acc = accounts[0]
    assert acc.account_id is not None
    assert acc.current_balance is not None
    assert acc.display_name != "Unknown"

    print(f"\nExtracted {len(accounts)} accounts")
    for account in accounts[:5]:
        print(f"{account.display_name} | ${account.current_balance:.2f}")


@pytest.mark.integration
def test_transactions_are_sorted_by_date_descending(demo_db_path):  # type: ignore[no-untyped-def]
    """Test that transactions are sorted by date in descending order."""
    transactions = decode_transactions(demo_db_path)

    # Check that dates are in descending order
    for i in range(min(10, len(transactions) - 1)):
        assert transactions[i].date >= transactions[i + 1].date


@pytest.mark.integration
def test_transactions_are_deduplicated(demo_db_path):  # type: ignore[no-untyped-def]
    """Test that duplicate transactions are removed."""
    transactions = decode_transactions(demo_db_path)

    # Check for duplicates
    seen = set()
    duplicates = 0
    for txn in transactions:
        key = (txn.display_name, txn.amount, txn.date)
        if key in seen:
            duplicates += 1
        seen.add(key)

    assert duplicates == 0, f"Found {duplicates} duplicate transactions"
