"""
Unit tests for Pydantic models.
"""

import pytest
from pydantic import ValidationError

from copilot_money_mcp.models.transaction import Transaction
from copilot_money_mcp.models.account import Account
from copilot_money_mcp.models.category import Category


class TestTransaction:
    """Tests for Transaction model."""

    def test_transaction_creation_with_required_fields(self) -> None:
        """Test creating a transaction with only required fields."""
        txn = Transaction(
            transaction_id="txn_123",
            amount=42.50,
            date="2026-01-10",
        )
        assert txn.transaction_id == "txn_123"
        assert txn.amount == 42.50
        assert txn.date == "2026-01-10"

    def test_transaction_creation_with_all_fields(self) -> None:
        """Test creating a transaction with all fields."""
        txn = Transaction(
            transaction_id="txn_456",
            amount=15.75,
            date="2026-01-08",
            name="Starbucks",
            original_name="STARBUCKS #12345",
            account_id="acc_789",
            category_id="cat_food",
            pending=False,
            user_reviewed=True,
            iso_currency_code="USD",
        )
        assert txn.transaction_id == "txn_456"
        assert txn.amount == 15.75
        assert txn.name == "Starbucks"
        assert txn.original_name == "STARBUCKS #12345"
        assert txn.account_id == "acc_789"
        assert txn.category_id == "cat_food"
        assert txn.pending is False
        assert txn.user_reviewed is True
        assert txn.iso_currency_code == "USD"

    def test_transaction_display_name_uses_name_first(self) -> None:
        """Test that display_name prefers name over original_name."""
        txn = Transaction(
            transaction_id="txn_001",
            amount=10.00,
            date="2026-01-01",
            name="Clean Name",
            original_name="DIRTY_NAME_123",
        )
        assert txn.display_name == "Clean Name"

    def test_transaction_display_name_falls_back_to_original_name(self) -> None:
        """Test that display_name falls back to original_name."""
        txn = Transaction(
            transaction_id="txn_002",
            amount=20.00,
            date="2026-01-01",
            original_name="ORIGINAL_NAME",
        )
        assert txn.display_name == "ORIGINAL_NAME"

    def test_transaction_display_name_defaults_to_unknown(self) -> None:
        """Test that display_name defaults to 'Unknown' when both are None."""
        txn = Transaction(
            transaction_id="txn_003",
            amount=30.00,
            date="2026-01-01",
        )
        assert txn.display_name == "Unknown"

    def test_transaction_validates_date_format(self) -> None:
        """Test that date validation works."""
        # Valid date format
        txn = Transaction(
            transaction_id="txn_004",
            amount=5.00,
            date="2026-12-31",
        )
        assert txn.date == "2026-12-31"

        # Invalid date format should raise ValidationError
        with pytest.raises(ValidationError):
            Transaction(
                transaction_id="txn_005",
                amount=5.00,
                date="01/15/2026",  # Wrong format
            )

    def test_transaction_validates_amount_range(self) -> None:
        """Test that amount validation rejects extreme values."""
        # Valid amounts
        Transaction(transaction_id="txn_006", amount=9_999_999.99, date="2026-01-01")
        Transaction(transaction_id="txn_007", amount=-9_999_999.99, date="2026-01-01")

        # Invalid amounts (too large)
        with pytest.raises(ValidationError):
            Transaction(transaction_id="txn_008", amount=10_000_001, date="2026-01-01")

        with pytest.raises(ValidationError):
            Transaction(transaction_id="txn_009", amount=-10_000_001, date="2026-01-01")

    def test_transaction_serialization(self) -> None:
        """Test that transactions can be serialized to dict/JSON."""
        txn = Transaction(
            transaction_id="txn_010",
            amount=99.99,
            date="2026-01-15",
            name="Test Merchant",
        )
        data = txn.model_dump()
        assert data["transaction_id"] == "txn_010"
        assert data["amount"] == 99.99
        assert data["name"] == "Test Merchant"

        json_str = txn.model_dump_json()
        assert "txn_010" in json_str
        assert "99.99" in json_str


class TestAccount:
    """Tests for Account model."""

    def test_account_creation_with_required_fields(self) -> None:
        """Test creating an account with required fields."""
        acc = Account(
            account_id="acc_123",
            name="Checking Account",
            current_balance=1234.56,
        )
        assert acc.account_id == "acc_123"
        assert acc.name == "Checking Account"
        assert acc.current_balance == 1234.56

    def test_account_creation_with_all_fields(self) -> None:
        """Test creating an account with all fields."""
        acc = Account(
            account_id="acc_456",
            name="Savings Account",
            official_name="High Yield Savings",
            account_type="savings",
            subtype="savings",
            mask="1234",
            current_balance=5000.00,
            available_balance=4950.00,
            iso_currency_code="USD",
            institution_name="Big Bank",
        )
        assert acc.account_type == "savings"
        assert acc.subtype == "savings"
        assert acc.mask == "1234"
        assert acc.available_balance == 4950.00
        assert acc.institution_name == "Big Bank"

    def test_account_display_name_prefers_name(self) -> None:
        """Test that display_name uses name first."""
        acc = Account(
            account_id="acc_001",
            name="My Checking",
            official_name="Chase Total Checking",
            current_balance=100.00,
        )
        assert acc.display_name == "My Checking"

    def test_account_display_name_falls_back_to_official_name(self) -> None:
        """Test that display_name falls back to official_name."""
        acc = Account(
            account_id="acc_002",
            official_name="Official Account Name",
            current_balance=200.00,
        )
        assert acc.display_name == "Official Account Name"

    def test_account_display_name_defaults_to_unknown(self) -> None:
        """Test that display_name defaults to 'Unknown' when both are None."""
        acc = Account(
            account_id="acc_003",
            current_balance=300.00,
        )
        assert acc.display_name == "Unknown"


class TestCategory:
    """Tests for Category model."""

    def test_category_creation(self) -> None:
        """Test creating a category."""
        cat = Category(
            category_id="cat_food",
            name="Food & Dining",
        )
        assert cat.category_id == "cat_food"
        assert cat.name == "Food & Dining"

    def test_category_with_parent(self) -> None:
        """Test creating a category with parent category."""
        cat = Category(
            category_id="cat_restaurants",
            name="Restaurants",
            parent_category_id="cat_food",
        )
        assert cat.parent_category_id == "cat_food"
