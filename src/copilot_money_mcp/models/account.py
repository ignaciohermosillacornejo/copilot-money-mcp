"""
Account model for Copilot Money data.
"""

from typing import Optional

from pydantic import BaseModel, computed_field


class Account(BaseModel):
    """
    Represents a financial account from Copilot Money.

    Based on Firestore document structure documented in REVERSE_ENGINEERING_FINDING.md.
    """

    model_config = {"strict": True, "populate_by_name": True}

    # Required fields
    account_id: str
    current_balance: float

    # Account identification
    name: Optional[str] = None
    official_name: Optional[str] = None
    mask: Optional[str] = None  # Last 4 digits

    # Account type
    account_type: Optional[str] = None  # checking, savings, credit, investment, loan
    subtype: Optional[str] = None

    # Balances
    available_balance: Optional[float] = None

    # Institution
    item_id: Optional[str] = None
    institution_id: Optional[str] = None
    institution_name: Optional[str] = None

    # Metadata
    iso_currency_code: Optional[str] = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def display_name(self) -> str:
        """Get the best display name for this account."""
        return self.name or self.official_name or "Unknown"
