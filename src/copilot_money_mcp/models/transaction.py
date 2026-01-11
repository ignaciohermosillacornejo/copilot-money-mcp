"""
Transaction model for Copilot Money data.
"""

from typing import Optional

from pydantic import BaseModel, Field, computed_field, field_validator


class Transaction(BaseModel):
    """
    Represents a financial transaction from Copilot Money.

    Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
    """

    model_config = {"strict": True, "populate_by_name": True}

    # Required fields
    transaction_id: str
    amount: float  # Positive = expense, Negative = income/credit
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    # Merchant/name fields
    name: Optional[str] = None
    original_name: Optional[str] = None
    original_clean_name: Optional[str] = None

    # Account & categorization
    account_id: Optional[str] = None
    item_id: Optional[str] = None
    user_id: Optional[str] = None
    category_id: Optional[str] = None
    plaid_category_id: Optional[str] = None
    category_id_source: Optional[str] = None

    # Dates
    original_date: Optional[str] = None

    # Amounts
    original_amount: Optional[float] = None

    # Status flags
    pending: Optional[bool] = None
    pending_transaction_id: Optional[str] = None
    user_reviewed: Optional[bool] = None
    plaid_deleted: Optional[bool] = None

    # Payment info
    payment_method: Optional[str] = None
    payment_processor: Optional[str] = None

    # Location
    city: Optional[str] = None
    region: Optional[str] = None
    address: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None

    # Metadata
    iso_currency_code: Optional[str] = None
    plaid_transaction_type: Optional[str] = None
    is_amazon: Optional[bool] = None
    from_investment: Optional[str] = None
    account_dashboard_active: Optional[bool] = None

    # References
    reference_number: Optional[str] = None
    ppd_id: Optional[str] = None
    by_order_of: Optional[str] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def display_name(self) -> str:
        """Get the best display name for this transaction."""
        return self.name or self.original_name or "Unknown"

    @field_validator("amount")
    @classmethod
    def validate_amount_range(cls, v: float) -> float:
        """Validate that amount is within reasonable range."""
        if abs(v) > 10_000_000:
            raise ValueError(f"Amount {v} exceeds maximum allowed value")
        return v
