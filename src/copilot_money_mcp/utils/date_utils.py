"""
Date utilities for parsing periods and date ranges.
"""

import calendar
from datetime import datetime, timedelta
from typing import Tuple


def parse_period(period: str) -> Tuple[str, str]:
    """
    Parse a period string into (start_date, end_date).

    Supported periods:
    - "this_month", "last_month"
    - "this_year", "last_year"
    - "last_7_days", "last_30_days", "last_90_days"
    - "ytd" (year to date)

    Returns:
        Tuple of (start_date, end_date) as "YYYY-MM-DD" strings

    Raises:
        ValueError: If period is not recognized
    """
    today = datetime.now()

    if period == "this_month":
        year = today.year
        month = today.month
        return get_month_range(year, month)

    elif period == "last_month":
        # Calculate previous month
        first_day_this_month = today.replace(day=1)
        last_day_last_month = first_day_this_month - timedelta(days=1)
        year = last_day_last_month.year
        month = last_day_last_month.month
        return get_month_range(year, month)

    elif period == "this_year":
        year = today.year
        start = f"{year}-01-01"
        end = f"{year}-12-31"
        return start, end

    elif period == "last_year":
        year = today.year - 1
        start = f"{year}-01-01"
        end = f"{year}-12-31"
        return start, end

    elif period == "last_7_days":
        start = today - timedelta(days=7)
        return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")

    elif period == "last_30_days":
        start = today - timedelta(days=30)
        return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")

    elif period == "last_90_days":
        start = today - timedelta(days=90)
        return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")

    elif period == "ytd":
        # Year to date: from Jan 1 to today
        start = f"{today.year}-01-01"
        end = today.strftime("%Y-%m-%d")
        return start, end

    else:
        raise ValueError(f"Unknown period: {period}")


def get_month_range(year: int, month: int) -> Tuple[str, str]:
    """
    Get the date range for a specific month.

    Args:
        year: Year (e.g., 2026)
        month: Month (1-12)

    Returns:
        Tuple of (start_date, end_date) as "YYYY-MM-DD" strings

    Raises:
        ValueError: If month is not in valid range (1-12)
    """
    if not 1 <= month <= 12:
        raise ValueError(f"Month must be between 1 and 12, got {month}")

    # Get the last day of the month
    _, last_day = calendar.monthrange(year, month)

    start = f"{year:04d}-{month:02d}-01"
    end = f"{year:04d}-{month:02d}-{last_day:02d}"

    return start, end
