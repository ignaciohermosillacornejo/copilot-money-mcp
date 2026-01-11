"""
Category model for Copilot Money data.
"""

from typing import Optional

from pydantic import BaseModel


class Category(BaseModel):
    """
    Represents a spending category from Copilot Money.

    Categories can be hierarchical with parent-child relationships.
    """

    model_config = {"strict": True, "populate_by_name": True}

    # Required fields
    category_id: str
    name: str

    # Optional fields
    parent_category_id: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
