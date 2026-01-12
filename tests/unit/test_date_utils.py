"""
Unit tests for date utilities.
"""

import pytest
from datetime import datetime, timedelta
from freezegun import freeze_time

from copilot_money_mcp.utils.date_utils import parse_period, get_month_range


class TestParsePeriod:
    """Tests for parse_period function."""

    @freeze_time("2026-01-15")
    def test_parse_this_month(self):
        """Test parsing 'this_month' period."""
        start, end = parse_period("this_month")
        assert start == "2026-01-01"
        assert end == "2026-01-31"

    @freeze_time("2026-01-15")
    def test_parse_last_month(self):
        """Test parsing 'last_month' period."""
        start, end = parse_period("last_month")
        assert start == "2025-12-01"
        assert end == "2025-12-31"

    @freeze_time("2026-01-15")
    def test_parse_this_year(self):
        """Test parsing 'this_year' period."""
        start, end = parse_period("this_year")
        assert start == "2026-01-01"
        assert end == "2026-12-31"

    @freeze_time("2026-01-15")
    def test_parse_last_year(self):
        """Test parsing 'last_year' period."""
        start, end = parse_period("last_year")
        assert start == "2025-01-01"
        assert end == "2025-12-31"

    @freeze_time("2026-01-15")
    def test_parse_last_7_days(self):
        """Test parsing 'last_7_days' period."""
        start, end = parse_period("last_7_days")
        # Should be 7 days ago to today
        assert start == "2026-01-08"
        assert end == "2026-01-15"

    @freeze_time("2026-01-15")
    def test_parse_last_30_days(self):
        """Test parsing 'last_30_days' period."""
        start, end = parse_period("last_30_days")
        assert start == "2025-12-16"
        assert end == "2026-01-15"

    @freeze_time("2026-01-15")
    def test_parse_last_90_days(self):
        """Test parsing 'last_90_days' period."""
        start, end = parse_period("last_90_days")
        assert start == "2025-10-17"
        assert end == "2026-01-15"

    @freeze_time("2026-01-15")
    def test_parse_ytd(self):
        """Test parsing 'ytd' (year to date) period."""
        start, end = parse_period("ytd")
        assert start == "2026-01-01"
        assert end == "2026-01-15"

    def test_parse_invalid_period(self):
        """Test that invalid period raises ValueError."""
        with pytest.raises(ValueError, match="Unknown period"):
            parse_period("invalid_period")

    @freeze_time("2026-02-15")
    def test_parse_last_month_february(self):
        """Test last_month when current month is February."""
        start, end = parse_period("last_month")
        assert start == "2026-01-01"
        assert end == "2026-01-31"

    @freeze_time("2026-03-15")
    def test_parse_last_month_march(self):
        """Test last_month when current month is March."""
        start, end = parse_period("last_month")
        # February 2026 (not a leap year)
        assert start == "2026-02-01"
        assert end == "2026-02-28"


class TestGetMonthRange:
    """Tests for get_month_range function."""

    def test_get_month_range_january(self):
        """Test getting range for January."""
        start, end = get_month_range(2026, 1)
        assert start == "2026-01-01"
        assert end == "2026-01-31"

    def test_get_month_range_february_non_leap_year(self):
        """Test getting range for February in non-leap year."""
        start, end = get_month_range(2026, 2)
        assert start == "2026-02-01"
        assert end == "2026-02-28"

    def test_get_month_range_february_leap_year(self):
        """Test getting range for February in leap year."""
        start, end = get_month_range(2024, 2)
        assert start == "2024-02-01"
        assert end == "2024-02-29"

    def test_get_month_range_december(self):
        """Test getting range for December."""
        start, end = get_month_range(2026, 12)
        assert start == "2026-12-01"
        assert end == "2026-12-31"

    def test_get_month_range_april(self):
        """Test getting range for April (30 days)."""
        start, end = get_month_range(2026, 4)
        assert start == "2026-04-01"
        assert end == "2026-04-30"

    def test_get_month_range_invalid_month(self):
        """Test that invalid month raises ValueError."""
        with pytest.raises(ValueError):
            get_month_range(2026, 13)

        with pytest.raises(ValueError):
            get_month_range(2026, 0)
